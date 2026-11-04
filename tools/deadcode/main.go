// Command deadcode is the Go half of `frontend/scripts/check-exports.cjs`: an exported identifier that nothing
// outside its own file can reach.
//
// **Why it exists.** The canvas fails on an export nobody imports and `tsc` fails on an unused local, but neither
// has a Go counterpart: `go vet` does not look at reachability, `golangci-lint`'s `unused` only sees unexported
// names, and `deadcode` needs the module proxy. So an exported function whose last caller a refactor removed
// stays behind, still claiming a capability, still compiling, and eleven of them had piled up before anything
// looked (docs/known-issues.md #2, decisions #253).
//
// **The rule.** A declaration is reachable when its name appears in a file other than the one that declares it,
// or when a reachable declaration mentions it — a type in a live function's signature, a constant a live method
// reads. Unreachable ones are reported. That second half is what keeps the check honest about types, which are
// reached structurally and hardly ever by name: `store.SpeechProfile` is never written outside its package, but
// `Active()` answers it, so it is not dead.
//
// **Over-approximations, all in the safe direction.** The scan is module-wide and name-keyed rather than
// package-keyed, because a mention cannot be resolved to a package without type-checking: a `New` used in one
// package keeps every `New` alive. Occurrences are counted anywhere an identifier can appear (a call, a selector
// — `x.Foo` counts for `Foo` — a struct field's name), and test files count, since a knob a test drives is used.
// What the program reports is therefore always real; what it misses is not.
//
// **Interface methods are exempt.** `func (e *Error) Code() string` is called through `interface{ Code() string }`
// and never by name, so a name-based check would call every implementation dead. The method names of every
// interface declared in the module are collected first — including the anonymous ones written at a call site —
// plus a short list of the standard library's own (encoding/json's marshallers, `error`, `fmt.Stringer`,
// `http.Handler`, the `sort` trio, `driver.Valuer`). That list is fixed rather than discovered because those
// interfaces live in the standard library, which this program does not parse.
//
// Usage:
//
//	go run ./tools/deadcode            # exits 1 when something is unreachable, printing it
//	go run ./tools/deadcode -v         # also prints every declaration it looked at
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// stdlibMethods are method names an exported declaration may have without being called by name, because a
// standard-library interface calls them: `json.Marshaler` and friends, `error`, `fmt.Stringer`, `http.Handler`,
// `sort.Interface`, `driver.Valuer`. A name that needs adding here is one line, and the gate says so rather than
// passing silently.
var stdlibMethods = map[string]bool{
	"Error": true, "Unwrap": true, "Is": true, "As": true, "Timeout": true, "Temporary": true,
	"String": true, "GoString": true,
	"MarshalJSON": true, "UnmarshalJSON": true, "MarshalText": true, "UnmarshalText": true,
	"MarshalBinary": true, "UnmarshalBinary": true, "MarshalYAML": true, "UnmarshalYAML": true,
	"ServeHTTP": true, "Serve": true, "Handler": true,
	"Read": true, "Write": true, "Close": true, "Flush": true, "Hijack": true,
	"Len": true, "Less": true, "Swap": true,
	"Scan": true, "Value": true,
}

// skipDirs are the directories that hold no product Go code or whose contents belong to something else.
var skipDirs = map[string]bool{"node_modules": true, "dist": true, ".git": true, "testdata": true, "vendor": true}

// declaration is one name declared at the top of a file: where it lives, whether it is exported, and every name its
// own declaration mentions.
//
// Unexported ones are collected too, and they are what makes the reachability honest: `entryDeps` is never named
// outside `derive.go`, but it is real code, and the exported type it answers is reachable through it. Assuming the
// unexported half is used — `golangci-lint`'s `unused` is what says otherwise — is the only reading that does not
// report a type for being answered by a private function.
type declaration struct {
	name     string
	file     string
	kind     string
	isMethod bool
	exported bool
	// test marks a declaration in a `_test.go` file: the test runner is what calls those, so they are live and the
	// names they mention are reachable.
	test bool
	refs []string
}

func main() {
	verbose := flag.Bool("v", false, "print every declaration that was looked at")
	flag.Parse()

	files, err := goFiles(".")
	if err != nil {
		fmt.Fprintf(os.Stderr, "deadcode: %v\n", err)
		os.Exit(2)
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "deadcode: no Go files found — run this from the module root")
		os.Exit(2)
	}

	set := token.NewFileSet()
	parsed := make(map[string]*ast.File, len(files))
	for _, file := range files {
		tree, err := parser.ParseFile(set, file, nil, parser.SkipObjectResolution)
		if err != nil {
			fmt.Fprintf(os.Stderr, "deadcode: %v\n", err)
			os.Exit(2)
		}
		parsed[file] = tree
	}

	declared, dead := analyse(parsed)
	exported := 0
	for _, entry := range declared {
		if !entry.exported || entry.test {
			continue
		}
		exported++
		if *verbose {
			fmt.Printf("looking at %s (%s) in %s\n", entry.name, entry.kind, entry.file)
		}
	}

	if len(dead) == 0 {
		fmt.Printf("deadcode check passed: %d exported declaration(s) in %s, every one reachable from another file\n", exported, moduleName())
		return
	}
	fmt.Printf("%d exported declaration(s) nothing outside their own file can reach:\n", len(dead))
	for _, entry := range dead {
		fmt.Printf("    %s  %s (%s)\n", strings.TrimPrefix(entry.file, "./"), entry.name, entry.kind)
	}
	fmt.Println("Delete them, unexport what only its own file needs, or give them a caller. A method an interface")
	fmt.Println("calls by name is exempt automatically; one a standard-library interface calls by name belongs in")
	fmt.Println("stdlibMethods in tools/deadcode/main.go.")
	os.Exit(1)
}

// analyse decides what is unreachable: every exported declaration, and the ones nothing outside their own file can
// reach. The file paths are the map's keys, so they are whatever the caller calls them.
func analyse(parsed map[string]*ast.File) (declared []declaration, dead []declaration) {
	files := make([]string, 0, len(parsed))
	for file := range parsed {
		files = append(files, file)
	}
	sort.Strings(files)

	// Where each name is mentioned, which names an interface declares a method of, and every declaration.
	mentions := map[string]map[string]bool{}
	interfaces := map[string]bool{}
	declared = make([]declaration, 0, 4*len(files))
	for _, file := range files {
		ast.Inspect(parsed[file], func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.Ident:
				if mentions[typed.Name] == nil {
					mentions[typed.Name] = map[string]bool{}
				}
				mentions[typed.Name][file] = true
			case *ast.InterfaceType:
				if typed.Methods == nil {
					return true
				}
				for _, field := range typed.Methods.List {
					for _, name := range field.Names {
						interfaces[name.Name] = true
					}
				}
			}
			return true
		})
		declared = append(declared, declarationsOf(file, parsed[file])...)
	}
	sort.Slice(declared, func(i, j int) bool {
		if declared[i].file != declared[j].file {
			return declared[i].file < declared[j].file
		}
		return declared[i].name < declared[j].name
	})

	// Reachability: a name is live when another file mentions it, when a live declaration mentions it, or when a
	// private declaration or a test mentions it. Interface methods are live whatever the analysis says, because an
	// interface is what calls them.
	live := map[string]bool{}
	pending := make([]string, 0, len(declared))
	mark := func(name string) {
		if !live[name] {
			live[name] = true
			pending = append(pending, name)
		}
	}
	byName := map[string][]declaration{}
	for _, entry := range declared {
		byName[entry.name] = append(byName[entry.name], entry)
		if !entry.exported || entry.test {
			// A private declaration, and a test, are live by definition — nothing here can see who calls them — so
			// everything they mention is reachable.
			for _, ref := range entry.refs {
				mark(ref)
			}
			continue
		}
		external := false
		for file := range mentions[entry.name] {
			if file != entry.file {
				external = true
				break
			}
		}
		if external || (entry.isMethod && (interfaces[entry.name] || stdlibMethods[entry.name])) {
			mark(entry.name)
		}
	}
	for len(pending) > 0 {
		name := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		for _, entry := range byName[name] {
			for _, ref := range entry.refs {
				mark(ref)
			}
		}
	}

	dead = make([]declaration, 0)
	for _, entry := range declared {
		if entry.exported && !entry.test && !live[entry.name] {
			dead = append(dead, entry)
		}
	}
	return declared, dead
}

// declarationsOf lists the declarations of one file, each with the names it mentions.
func declarationsOf(file string, tree *ast.File) []declaration {
	out := make([]declaration, 0, 16)
	isTest := strings.HasSuffix(file, "_test.go")
	add := func(name, kind string, node ast.Node, isMethod bool) {
		out = append(out, declaration{name: name, file: file, kind: kind, isMethod: isMethod, exported: ast.IsExported(name), test: isTest, refs: namesIn(node)})
	}
	// A declaration is one spec, not the whole block: two constants in one `const (...)` are two declarations, and
	// one of them being live must not keep the other alive.
	for _, decl := range tree.Decls {
		switch typed := decl.(type) {
		case *ast.FuncDecl:
			if typed.Recv != nil {
				add(typed.Name.Name, "method", typed, true)
			} else {
				add(typed.Name.Name, "func", typed, false)
			}
		case *ast.GenDecl:
			for _, spec := range typed.Specs {
				switch entry := spec.(type) {
				case *ast.TypeSpec:
					add(entry.Name.Name, "type", entry, false)
				case *ast.ValueSpec:
					for _, name := range entry.Names {
						add(name.Name, strings.ToLower(typed.Tok.String()), entry, false)
					}
				}
			}
		}
	}
	return out
}

// namesIn is every identifier mentioned inside one node, sorted and deduplicated.
func namesIn(node ast.Node) []string {
	seen := map[string]bool{}
	ast.Inspect(node, func(inner ast.Node) bool {
		if ident, ok := inner.(*ast.Ident); ok {
			seen[ident.Name] = true
		}
		return true
	})
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// goFiles is every .go file of the module, with paths relative to the current directory.
func goFiles(root string) ([]string, error) {
	out := make([]string, 0, 128)
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if skipDirs[info.Name()] && path != root {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			out = append(out, path)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

// moduleName is the module path from go.mod, for the summary line.
func moduleName() string {
	data, err := os.ReadFile("go.mod")
	if err != nil {
		return "this module"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "module ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "module "))
		}
	}
	return "this module"
}
