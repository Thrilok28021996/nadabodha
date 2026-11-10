from svara.exports import build_srt, build_vtt
from svara.transcriber import Segment


def test_srt_timestamps_and_numbering():
    segments = [Segment(0.0, 1.5, "hello"), Segment(61.25, 63.0, "world")]
    text = build_srt(segments)
    assert text.startswith("1\n00:00:00,000 --> 00:00:01,500\nhello")
    assert "2\n00:01:01,250 --> 00:01:03,000\nworld" in text
    assert text.endswith("\n")


def test_vtt_header_and_dot_separator():
    text = build_vtt([Segment(0.0, 2.0, "hello")])
    assert text.startswith("WEBVTT\n\n")
    assert "00:00:00.000 --> 00:00:02.000" in text


def test_empty_segments_produce_empty_srt():
    assert build_srt([]) == ""
    assert build_vtt([]).startswith("WEBVTT")
