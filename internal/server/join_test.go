package server

// Joining clips: the decision, and one real join through ffmpeg.
//
// The decision is what a stream copy can and cannot take, and it is pure — so it is tested without any media
// at all. The join itself is tested against two clips ffmpeg makes in a temp directory, because the whole
// point of the route is that the bytes come out right; a test that mocks the muxer would only prove the
// arguments were spelled.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// clipStream is one video track of a clip, for the comparison tests.
func clipStream(codec string, width, height int, pixel, rate string) joinStream {
	return joinStream{kind: "video", codec: codec, width: width, height: height, pixel: pixel, frameRate: rate}
}

func audioStream(codec, rate string, channels int) joinStream {
	return joinStream{kind: "audio", codec: codec, sampleRate: rate, channels: channels}
}

/**
 * Every difference a stream copy would take silently.
 *
 * ffmpeg's concat demuxer does not refuse inputs it cannot stitch — it writes the file, and the file plays
 * until the first seam and then stops. So the sentence has to name the clip and the field, and it has to be
 * produced before anything is written: this is that decision.
 */
func TestJoinDifferenceNamesTheFileAndTheField(t *testing.T) {
	base := joinInput{name: "clip-1.mp4", streams: []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1")}}
	cases := []struct {
		what  string
		other []joinStream
		want  string
	}{
		{"a different codec", []joinStream{clipStream("hevc", 64, 64, "yuv420p", "10/1")}, "clip-2.mp4 is hevc and clip-1.mp4 is h264"},
		{"a different size", []joinStream{clipStream("h264", 96, 64, "yuv420p", "10/1")}, "clip-2.mp4 is 96×64 and clip-1.mp4 is 64×64"},
		{"a different pixel format", []joinStream{clipStream("h264", 64, 64, "yuv444p", "10/1")}, "clip-2.mp4 is yuv444p and clip-1.mp4 is yuv420p"},
		{"a different frame rate", []joinStream{clipStream("h264", 64, 64, "yuv420p", "30000/1001")}, "clip-2.mp4 runs at 29.97002997002997 fps and clip-1.mp4 runs at 10 fps"},
		{"a track the first does not have", []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1"), audioStream("aac", "44100", 2)}, "clip-2.mp4 has video and audio and clip-1.mp4 has video"},
	}
	for _, testCase := range cases {
		inputs := []joinInput{base, {name: "clip-2.mp4", streams: testCase.other}}
		if got := joinDifference(inputs); got != testCase.want {
			t.Errorf("%s: joinDifference = %q, want %q", testCase.what, got, testCase.want)
		}
	}
}

func TestJoinDifferenceIsSilentWhenTheClipsAgree(t *testing.T) {
	same := []joinInput{
		{name: "clip-1.mp4", streams: []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1"), audioStream("aac", "44100", 2)}},
		{name: "clip-2.mp4", streams: []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1"), audioStream("aac", "44100", 2)}},
		{name: "clip-3.mp4", streams: []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1"), audioStream("aac", "44100", 2)}},
	}
	if got := joinDifference(same); got != "" {
		t.Errorf("joinDifference = %q, want nothing", got)
	}
}

func TestJoinDifferenceOnASoundChannelCount(t *testing.T) {
	inputs := []joinInput{
		{name: "clip-1.mp4", streams: []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1"), audioStream("aac", "44100", 2)}},
		{name: "clip-2.mp4", streams: []joinStream{clipStream("h264", 64, 64, "yuv420p", "10/1"), audioStream("aac", "44100", 1)}},
	}
	want := "clip-2.mp4 carries 44.1 kHz across 1 channel and clip-1.mp4 carries 44.1 kHz across 2 channels"
	if got := joinDifference(inputs); got != want {
		t.Errorf("joinDifference = %q, want %q", got, want)
	}
}

/** The route's own refusals, which need no media: nothing to join, and a file the canvas does not hold. */
func TestJoinRefusesWhatItCannotJoin(t *testing.T) {
	srv := newTestServer(t, newFakeComfy(t))
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	base := canvasBase(t, server.URL)

	status, payload := doJSON(t, server.Client(), http.MethodPost, base+"/join", map[string]any{"files": []any{"clip-1.mp4"}})
	if status != http.StatusBadRequest {
		t.Fatalf("one file: status = %d, want 400 (%v)", status, payload)
	}
	if code := failureCode(t, payload); code != "join_needs_two" {
		t.Errorf("one file: error = %q, want join_needs_two", code)
	}

	status, payload = doJSON(t, server.Client(), http.MethodPost, base+"/join", map[string]any{"files": []any{"clip-1.mp4", "clip-2.mp4"}})
	if status != http.StatusNotFound {
		t.Fatalf("missing files: status = %d, want 404 (%v)", status, payload)
	}

	status, payload = doJSON(t, server.Client(), http.MethodPost, base+"/join", map[string]any{"files": []any{"../canvas.json", "clip-1.mp4"}})
	if status != http.StatusBadRequest {
		t.Fatalf("a name outside the canvas: status = %d, want 400 (%v)", status, payload)
	}
	if code := failureCode(t, payload); code != "join_file_invalid" {
		t.Errorf("a name outside the canvas: error = %q, want join_file_invalid", code)
	}
}

/**
 * One real join: two ten-frame clips become one twenty-frame clip, by copy.
 *
 * ffmpeg is the thing being trusted here, so the test needs it — and says so rather than passing when it is
 * not installed. What it holds is the route's promise: the answer carries the clip's own length and size, and
 * the file it names is the one the canvas now serves.
 */
func TestJoinWritesOneClipOutOfTwo(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed, so there is nothing to join with")
	}
	srv := newTestServer(t, newFakeComfy(t))
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	base := canvasBase(t, server.URL)

	first := uploadID(t, server, "clip-1.mp4", "video/mp4", clipBytes(t, "red", 64, 10))
	second := uploadID(t, server, "clip-2.mp4", "video/mp4", clipBytes(t, "blue", 64, 10))

	status, payload := doJSON(t, server.Client(), http.MethodPost, base+"/join", map[string]any{"files": []any{first, second}})
	if status != http.StatusOK {
		t.Fatalf("join: status = %d, want 200 (%v)", status, payload)
	}
	if payload["mode"] != "copy" {
		t.Errorf("mode = %v, want copy: two clips of one kind need no re-encode", payload["mode"])
	}
	if width, _ := payload["width"].(float64); int(width) != 64 {
		t.Errorf("width = %v, want 64", payload["width"])
	}
	duration, _ := payload["durationMs"].(float64)
	// Ten frames at 10 fps is 1 s each; a join that lost a seam or a timestamp is not 2 s.
	if duration < 1900 || duration > 2200 {
		t.Errorf("durationMs = %v, want about 2000", duration)
	}
	uploaded, _ := payload["upload"].(map[string]any)
	name, _ := uploaded["id"].(string)
	if name == "" {
		t.Fatalf("join returned no file name: %v", payload)
	}

	response, err := server.Client().Get(base + "/files/" + name)
	if err != nil {
		t.Fatalf("fetch the joined file: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the joined file is not served: status = %d", response.StatusCode)
	}
}

/** Clips that were not made the same way are refused, and the re-encode is the caller's to ask for. */
func TestJoinRefusesClipsThatDoNotMatch(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed, so there is nothing to join with")
	}
	srv := newTestServer(t, newFakeComfy(t))
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	base := canvasBase(t, server.URL)

	small := uploadID(t, server, "clip-1.mp4", "video/mp4", clipBytes(t, "red", 64, 10))
	large := uploadID(t, server, "clip-2.mp4", "video/mp4", clipBytes(t, "blue", 96, 10))

	status, payload := doJSON(t, server.Client(), http.MethodPost, base+"/join", map[string]any{"files": []any{small, large}})
	if status != http.StatusBadRequest {
		t.Fatalf("mismatched clips: status = %d, want 400 (%v)", status, payload)
	}
	message := failureMessage(t, payload)
	if !strings.Contains(message, large) || !strings.Contains(message, small) {
		t.Errorf("the refusal does not name both clips: %q", message)
	}
	if !strings.Contains(message, "re-encoding") {
		t.Errorf("the refusal does not say what joining them anyway would cost: %q", message)
	}
}

// clipBytes makes one silent clip with ffmpeg: `frames` frames of a flat colour at 10 fps.
func clipBytes(t *testing.T, colour string, size, frames int) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), colour+".mp4")
	command := exec.Command("ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c="+colour+":s="+itoa(size)+"x"+itoa(size)+":r=10",
		"-frames:v", itoa(frames), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", path)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("make a clip with ffmpeg: %v (%s)", err, out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the clip: %v", err)
	}
	return data
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

// failureCode and failureMessage read the one error shape this server answers with.
func failureCode(t *testing.T, payload map[string]any) string {
	t.Helper()
	failure, _ := payload["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func failureMessage(t *testing.T, payload map[string]any) string {
	t.Helper()
	failure, _ := payload["error"].(map[string]any)
	message, _ := failure["message"].(string)
	return message
}
