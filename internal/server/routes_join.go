package server

// Joining clips into one — the one media operation the browser cannot do.
//
//   POST /api/canvases/{id}/join   {"files": ["<name>", ...], "reencode": false}
//     -> {"upload": {...}, "durationMs": 61200, "width": 1280, "height": 720, "mode": "copy"}
//
// A longer video is a chain: each clip is made from the frame the one before it ended on, and the user is left
// with five clips when they asked for one video. Taking a frame needs nothing but a canvas, which is why that
// is the page's (`capture_frame`); making one file out of five needs a muxer, and the browser has none. So
// this is the server's, and it is deliberately not a run: no model, no GPU, no queue — a stream copy of clips
// that were made the same way.
//
// What it will not do is guess. A stream copy is only honest when the inputs agree on what a stream *is*
// (codec, size, pixel format, frame rate, sample rate, channel count), so they are probed first and a
// disagreement is refused with the file and the field that differ. Re-encoding would join them, and it is
// available — but only when the caller asks for it, because it re-encodes every frame of the result to
// accommodate the one input that did not fit.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"comfyloft/internal/httpx"
	"comfyloft/internal/upload"
	"comfyloft/internal/util"
)

// How many clips one join may take. Bounded because every input is a file read and an argument line.
const maxJoinInputs = 64

// How long a join may take: a stream copy is instant, and a re-encode of an hour is not.
const joinTimeout = 30 * time.Minute

func (s *Server) routesJoin(mux *http.ServeMux) {
	s.route(mux, "POST /api/canvases/{id}/join", s.handleJoinClips)
}

// joinInput is one file of a join: where its bytes are, and what ffprobe said about it.
type joinInput struct {
	name     string
	path     string
	duration float64
	streams  []joinStream
}

// joinStream is one track of a file, reduced to the fields a stream copy has to see agree.
type joinStream struct {
	kind       string // "video" or "audio"
	codec      string
	width      int
	height     int
	pixel      string
	frameRate  string
	sampleRate string
	channels   int
}

// handleJoinClips implements POST /api/canvases/{id}/join.
func (s *Server) handleJoinClips(ctx *httpx.Ctx) error {
	canvasID := ctx.R.PathValue("id")
	if !s.canvasExists(canvasID) {
		return httpx.NotFound("canvas_not_found", "there is no canvas with that id")
	}
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	names := httpx.StringSlice(body, "files")
	if len(names) < 2 {
		return httpx.NewError(http.StatusBadRequest, "join_needs_two", "a join takes at least two files, in the order they should play")
	}
	if len(names) > maxJoinInputs {
		return httpx.Errorf(http.StatusBadRequest, "join_too_many", "a join takes at most %d files; join them in groups, or one after another", maxJoinInputs)
	}
	reencode := httpx.Bool(body, "reencode")

	inputs := make([]joinInput, 0, len(names))
	for _, name := range names {
		path, err := s.canvases.FilePath(canvasID, name)
		if err != nil {
			return httpx.Errorf(http.StatusBadRequest, "join_file_invalid", "%q is not a file of this canvas", name)
		}
		if !util.Exists(path) {
			return httpx.Errorf(http.StatusNotFound, "join_file_missing", "this canvas no longer holds %s", name)
		}
		probed, err := s.probeMedia(path)
		if err != nil {
			return httpx.Errorf(http.StatusBadRequest, "join_file_unreadable", "could not read %s: %s", name, err)
		}
		inputs = append(inputs, joinInput{name: name, path: path, duration: probed.Duration, streams: probed.Streams})
	}

	// A join is pictures into a picture: a sound joined to a clip is not a longer clip, and nothing on the
	// canvas asks for one yet.
	if first := inputs[0]; !isVideo(first) {
		return httpx.Errorf(http.StatusBadRequest, "join_not_video", "%s holds no video track: join_clips joins films into a film", first.name)
	}
	mode := "copy"
	if difference := joinDifference(inputs); difference != "" {
		if !reencode {
			return httpx.Errorf(http.StatusBadRequest, "join_inputs_differ",
				"%s. These clips are not the same, so a stream copy cannot join them — re-encoding every frame of the result would, and that is what reencode asks for", difference)
		}
		mode = "reencode"
	}

	output, err := s.runJoin(canvasID, inputs, mode)
	if err != nil {
		return err
	}
	return s.finishJoin(ctx, canvasID, inputs, output, mode)
}

// isVideo says whether this file has a picture at all, which is what makes it a clip.
func isVideo(input joinInput) bool {
	_, ok := videoStream(input.streams)
	return ok
}

// videoStream is the track a clip's picture is on, whatever order the container puts its tracks in.
func videoStream(streams []joinStream) (joinStream, bool) {
	for _, stream := range streams {
		if stream.kind == "video" {
			return stream, true
		}
	}
	return joinStream{}, false
}

// joinDifference names the first input a stream copy could not take as it is, or "" when all agree.
//
// The first file is the reference, deliberately: it is the one the caller named first, so the sentence names
// the file the user would ask about second and says what the first one is.
func joinDifference(inputs []joinInput) string {
	base := inputs[0]
	for _, other := range inputs[1:] {
		if len(other.streams) != len(base.streams) {
			return fmt.Sprintf("%s has %s and %s has %s", other.name, tracksWords(other.streams), base.name, tracksWords(base.streams))
		}
		for index, stream := range other.streams {
			if said, baseSaid := streamDifference(base.streams[index], stream); said != "" {
				return fmt.Sprintf("%s %s and %s %s", other.name, said, base.name, baseSaid)
			}
		}
	}
	return ""
}

// streamDifference is what one track of two files disagrees about, as the two halves of a sentence.
func streamDifference(base, other joinStream) (string, string) {
	if other.codec != base.codec {
		return fmt.Sprintf("is %s", other.codec), fmt.Sprintf("is %s", base.codec)
	}
	if other.kind != "video" {
		if other.sampleRate != base.sampleRate || other.channels != base.channels {
			return fmt.Sprintf("carries %s across %d channel%s", hertzWords(other.sampleRate), other.channels, plural(other.channels)),
				fmt.Sprintf("carries %s across %d channel%s", hertzWords(base.sampleRate), base.channels, plural(base.channels))
		}
		return "", ""
	}
	if other.width != base.width || other.height != base.height {
		return fmt.Sprintf("is %d×%d", other.width, other.height), fmt.Sprintf("is %d×%d", base.width, base.height)
	}
	if other.pixel != base.pixel {
		return fmt.Sprintf("is %s", other.pixel), fmt.Sprintf("is %s", base.pixel)
	}
	if other.frameRate != base.frameRate {
		return fmt.Sprintf("runs at %s", fpsWords(other.frameRate)), fmt.Sprintf("runs at %s", fpsWords(base.frameRate))
	}
	return "", ""
}

func tracksWords(streams []joinStream) string {
	if len(streams) == 0 {
		return "no tracks"
	}
	parts := make([]string, 0, len(streams))
	for _, stream := range streams {
		parts = append(parts, stream.kind)
	}
	return strings.Join(parts, " and ")
}

func plural(number int) string {
	if number == 1 {
		return ""
	}
	return "s"
}

// fpsWords turns ffprobe's "24/1" into "24 fps", which is what a refusal has to say out loud.
func fpsWords(rate string) string {
	value := rateValue(rate)
	if value <= 0 {
		return "an unknown frame rate"
	}
	return strconv.FormatFloat(value, 'f', -1, 64) + " fps"
}

func hertzWords(rate string) string {
	value := rateValue(rate)
	if value <= 0 {
		return "an unknown sample rate"
	}
	return strconv.FormatFloat(value/1000, 'f', -1, 64) + " kHz"
}

// rateValue reads an ffprobe rational ("24/1", "30000/1001") as a number.
func rateValue(rate string) float64 {
	parts := strings.Split(rate, "/")
	switch len(parts) {
	case 2:
		numerator, _ := strconv.ParseFloat(parts[0], 64)
		denominator, _ := strconv.ParseFloat(parts[1], 64)
		if denominator != 0 {
			return numerator / denominator
		}
	case 1:
		value, _ := strconv.ParseFloat(parts[0], 64)
		return value
	}
	return 0
}

// mediaProbe is what a probe found in one file: how long it runs, and the tracks a copy has to see agree.
type mediaProbe struct {
	Duration float64
	Streams  []joinStream
}

// probeMedia asks ffprobe what a file is — the same tool and the same log line as the length probe.
func (s *Server) probeMedia(path string) (*mediaProbe, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	args := []string{
		"-v", "error",
		"-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels",
		"-show_entries", "format=duration",
		"-of", "json", path,
	}
	s.logger.Info("running external command: %s", util.CommandLine("ffprobe", args...))
	out, err := exec.CommandContext(ctx, "ffprobe", args...).Output()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("ffprobe is not installed, so this server cannot read what a file is: %w", exec.ErrNotFound)
		}
		return nil, fmt.Errorf("ffprobe could not read it: %w", err)
	}

	var parsed struct {
		Streams []struct {
			CodecType   string `json:"codec_type"`
			CodecName   string `json:"codec_name"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			PixelFormat string `json:"pix_fmt"`
			FrameRate   string `json:"avg_frame_rate"`
			SampleRate  string `json:"sample_rate"`
			Channels    int    `json:"channels"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("ffprobe answered something this server cannot read: %w", err)
	}
	probe := &mediaProbe{}
	probe.Duration, _ = strconv.ParseFloat(parsed.Format.Duration, 64)
	if probe.Duration <= 0 {
		return nil, errors.New("ffprobe reports no duration")
	}
	for _, stream := range parsed.Streams {
		// Subtitles and the like are tracks too, and a copy cannot be told to drop one that only some of the
		// inputs have — so they take part in the comparison as their own kind rather than being ignored.
		probe.Streams = append(probe.Streams, joinStream{
			kind:       stream.CodecType,
			codec:      stream.CodecName,
			width:      stream.Width,
			height:     stream.Height,
			pixel:      stream.PixelFormat,
			frameRate:  stream.FrameRate,
			sampleRate: stream.SampleRate,
			channels:   stream.Channels,
		})
	}
	return probe, nil
}

// runJoin writes the joined file and answers its path — in the canvas's own directory, so moving it into place
// is a rename and a half-written file never sits where a URL would serve it.
func (s *Server) runJoin(canvasID string, inputs []joinInput, mode string) (string, error) {
	dir, err := s.canvases.FilesPath(canvasID)
	if err != nil {
		return "", httpx.NewError(http.StatusInternalServerError, "join_failed", "could not find the canvas directory: "+err.Error())
	}
	list, err := os.CreateTemp("", "join-*.txt")
	if err != nil {
		return "", httpx.NewError(http.StatusInternalServerError, "join_failed", "could not write the join list: "+err.Error())
	}
	defer os.Remove(list.Name())
	for _, input := range inputs {
		if _, err := fmt.Fprintf(list, "file '%s'\n", strings.ReplaceAll(input.path, "'", `'\''`)); err != nil {
			list.Close()
			return "", httpx.NewError(http.StatusInternalServerError, "join_failed", "could not write the join list: "+err.Error())
		}
	}
	list.Close()

	output, err := os.CreateTemp(dir, ".join-*.mp4")
	if err != nil {
		return "", httpx.NewError(http.StatusInternalServerError, "join_failed", "could not place the joined file: "+err.Error())
	}
	outputPath := output.Name()
	output.Close()

	args := []string{"-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list.Name()}
	if mode == "reencode" {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k")
	} else {
		args = append(args, "-c", "copy")
	}
	args = append(args, "-movflags", "+faststart", outputPath)

	ctx, cancel := context.WithTimeout(context.Background(), joinTimeout)
	defer cancel()
	s.logger.Info("running external command: %s", util.CommandLine("ffmpeg", args...))
	var stderr bytes.Buffer
	command := exec.CommandContext(ctx, "ffmpeg", args...)
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		os.Remove(outputPath)
		if errors.Is(err, exec.ErrNotFound) {
			return "", httpx.NewError(http.StatusServiceUnavailable, "ffmpeg_missing", "ffmpeg is not installed on this server, so clips cannot be joined; everything else works without it")
		}
		return "", httpx.Errorf(http.StatusInternalServerError, "join_failed", "ffmpeg could not join these clips: %s", lastLine(stderr.String()))
	}
	return outputPath, nil
}

// finishJoin verifies what ffmpeg wrote, moves it into the canvas, and answers with it.
//
// Not trusting the exit code is the point: a copy that lost its timestamps plays until the first seam and
// stops, and the page would have saved that as a node. A duration that is not the sum of the inputs is that
// failure, so the file is thrown away rather than handed over.
func (s *Server) finishJoin(ctx *httpx.Ctx, canvasID string, inputs []joinInput, outputPath, mode string) error {
	defer os.Remove(outputPath)

	probe, err := s.probeMedia(outputPath)
	if err != nil {
		return httpx.Errorf(http.StatusInternalServerError, "join_failed", "the joined file could not be read back: %s", err)
	}
	expected := 0.0
	for _, input := range inputs {
		expected += input.duration
	}
	if probe.Duration < expected-toleranceFor(expected) {
		return httpx.Errorf(http.StatusInternalServerError, "join_incomplete", "the join came out %s long when the clips are %s in all: the parts did not fit together, and nothing was saved", secondsWords(probe.Duration), secondsWords(expected))
	}
	video, ok := videoStream(probe.Streams)
	if !ok {
		return httpx.NewError(http.StatusInternalServerError, "join_incomplete", "the joined file holds no video track, so nothing was saved")
	}

	stored, err := s.uploads.Adopt(canvasID, upload.KindVideo, "joined.mp4", "video/mp4", outputPath)
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, "join_failed", "the joined file could not be stored: "+err.Error())
	}
	okJSON(ctx.W, map[string]any{
		"upload":     uploadPayload(canvasID, stored),
		"durationMs": int(probe.Duration*1000 + 0.5),
		"width":      video.width,
		"height":     video.height,
		"mode":       mode,
	})
	return nil
}

// toleranceFor is how far short of the sum a join may come and still be the same clip: a percent, and at
// least a fifth of a second, because a container's reported length is not exact and a two-second join has no
// 20 ms to spare.
func toleranceFor(expected float64) float64 {
	if percent := expected * 0.01; percent > 0.2 {
		return percent
	}
	return 0.2
}

func secondsWords(seconds float64) string {
	return strconv.FormatFloat(seconds, 'f', 1, 64) + " s"
}

// lastLine is ffmpeg's own sentence, which is the last thing it said — the rest is its banner and progress.
func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if line := strings.TrimSpace(lines[index]); line != "" {
			return line
		}
	}
	return "it gave no reason"
}
