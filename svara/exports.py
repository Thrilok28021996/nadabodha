"""Subtitle/timed-text exports built from Whisper segments."""

from __future__ import annotations

from .transcriber import Segment


def _clock(seconds: float, separator: str) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def build_srt(segments: list[Segment]) -> str:
    blocks: list[str] = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(str(index))
        blocks.append(f"{_clock(segment.start, ',')} --> {_clock(segment.end, ',')}")
        blocks.append(segment.text)
        blocks.append("")
    return "\n".join(blocks)


def build_vtt(segments: list[Segment]) -> str:
    blocks: list[str] = ["WEBVTT", ""]
    for segment in segments:
        blocks.append(f"{_clock(segment.start, '.')} --> {_clock(segment.end, '.')}")
        blocks.append(segment.text)
        blocks.append("")
    return "\n".join(blocks)
