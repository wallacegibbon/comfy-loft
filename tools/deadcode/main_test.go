package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"strings"
	"testing"
)

/**
 * The rules the gate is worth having for, pinned as small source trees.
 *
 * Every one of them is a case the module actually contains: a type answered by a private function
 * (`resource.DerivedDependency` through `entryDeps`), a constant read only by the code beside it
 * (`agent.MaxFrameSize`), a method called through an anonymous interface (`store.InvalidIDError.Code`), and a
 * test that drives an exported knob. A gate that quietly stopped reporting would be worse than none, because
 * `make check` would go on saying it did.
 */
func analyseSource(t *testing.T, files map[string]string) (int, []string) {
	t.Helper()
	set := token.NewFileSet()
	parsed := make(map[string]*ast.File, len(files))
	for path, source := range files {
		tree, err := parser.ParseFile(set, path, source, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		parsed[path] = tree
	}
	declared, dead := analyse(parsed)
	exported := 0
	for _, entry := range declared {
		if entry.exported && !entry.test {
			exported++
		}
	}
	names := make([]string, 0, len(dead))
	for _, entry := range dead {
		names = append(names, entry.name)
	}
	sort.Strings(names)
	return exported, names
}

func TestAFunctionNothingCallsIsReported(t *testing.T) {
	exported, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

// Queue reads the current queue.
func Queue() {}

func used() { helper() }

func helper() {}
`,
	})

	if exported != 1 {
		t.Errorf("counted %d exported declarations, want 1", exported)
	}
	if len(dead) != 1 || dead[0] != "Queue" {
		t.Errorf("dead = %v, want [Queue]", dead)
	}
}

// The caller may be anywhere: another file of the same package counts, which is why the rule is "outside its own
// file" and not "outside its package".
func TestACallerInAnotherFileOfTheSamePackageCounts(t *testing.T) {
	_, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

func Used() {}
`,
		"a/b.go": `package a

func caller() { Used() }
`,
	})

	if len(dead) != 0 {
		t.Errorf("dead = %v, want nothing", dead)
	}
}

// A type is reached structurally and hardly ever by name: `SpeechProfile` is never written outside `store`, but a
// live function answers it, so it is not dead — nor is a constant the code beside it reads.
func TestATypeOrConstantALiveDeclarationMentionsIsReachable(t *testing.T) {
	_, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

type Profile struct{ Name string }

const MaxFrame = 4096

func Active() (Profile, bool) { return Profile{}, false }

func read(size int) int { return size }

func Reader() int { return read(MaxFrame) }
`,
		"b/b.go": `package b

import "x/a"

var _ = a.Active
var _ = a.Reader
`,
	})

	if len(dead) != 0 {
		t.Errorf("dead = %v, want nothing — Profile is Active's answer and MaxFrame is Reader's", dead)
	}
}

// A private declaration is live by definition, so what it mentions is reachable: this is the `entryDeps` case, and
// without it every type a private helper builds would be reported.
func TestWhatAPrivateDeclarationMentionsIsReachable(t *testing.T) {
	_, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

type Dependency struct{ Resources []string }

func entryDeps() Dependency { return Dependency{} }

func Used() { _ = entryDeps() }
`,
		"b/b.go": `package b

import "x/a"

var _ = a.Used
`,
	})

	if len(dead) != 0 {
		t.Errorf("dead = %v, want nothing — Dependency is what a private function answers", dead)
	}
}

// A method an interface calls is never named, so it is exempt — both a module's own interface and the standard
// library's, which this program cannot see declared anywhere.
func TestInterfaceMethodsAreExempt(t *testing.T) {
	_, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

type Coded interface{ Code() string }

func (e *Err) Code() string { return "" }

func (e *Err) Error() string { return "" }

func (e *Err) MarshalJSON() ([]byte, error) { return nil, nil }

type Err struct{}
`,
		"b/b.go": `package b

var _ = func(code interface{ Code() string }) { _ = code.Code() }
`,
	})

	// The three methods are exempt, and they mention `Err` as their receiver, so the type survives with them. The
	// interface itself is named nowhere outside its own file — `b` writes its own, anonymous — so it is reported.
	if len(dead) != 1 || dead[0] != "Coded" {
		t.Errorf("dead = %v, want [Coded] — the methods are called by name only through interfaces", dead)
	}
}

// A test drives exported knobs, and the test runner is what calls a test: neither is dead.
func TestTestsAndWhatTheyUseAreLive(t *testing.T) {
	_, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

func WithServerPort(port int) int { return port }
`,
		"a/a_test.go": `package a

import "testing"

func TestServerPort(t *testing.T) { _ = WithServerPort(1) }
`,
	})

	if len(dead) != 0 {
		t.Errorf("dead = %v, want nothing — a test calls WithServerPort", dead)
	}
}

// Two constants in one block are two declarations: one of them being read must not keep the other alive.
func TestOneLiveConstantDoesNotSaveItsNeighbour(t *testing.T) {
	_, dead := analyseSource(t, map[string]string{
		"a/a.go": `package a

const (
	Live = 1
	Dead = 2
)

func Used() int { return Live }
`,
		"b/b.go": `package b

import "x/a"

var _ = a.Used
`,
	})

	if len(dead) != 1 || !strings.Contains(strings.Join(dead, ","), "Dead") {
		t.Errorf("dead = %v, want [Dead] only", dead)
	}
}
