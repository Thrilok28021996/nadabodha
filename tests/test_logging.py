import json

from svara.logging_setup import AppLogger


def _records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_writes_json_lines(tmp_path):
    path = tmp_path / "logs" / "svara.log"
    logger = AppLogger(path)
    logger.info("scope", "hello", {"value": 1})
    logger.warn("scope", "careful")
    records = _records(path)
    assert records[0]["level"] == "INFO"
    assert records[0]["scope"] == "scope"
    assert records[0]["message"] == "hello"
    assert records[0]["details"] == {"value": 1}
    assert records[1]["level"] == "WARN"


def test_error_includes_traceback(tmp_path):
    path = tmp_path / "svara.log"
    logger = AppLogger(path)
    try:
        raise ValueError("boom")
    except ValueError as error:
        logger.error("scope", "failed", error)
    record = _records(path)[0]
    assert record["level"] == "ERROR"
    assert record["details"]["type"] == "ValueError"
    assert record["details"]["message"] == "boom"
    assert "Traceback" in record["details"]["traceback"]


def test_rotation_keeps_one_previous_file(tmp_path):
    path = tmp_path / "svara.log"
    logger = AppLogger(path, max_bytes=200)
    for index in range(50):
        logger.info("scope", "x" * 20, {"index": index})
    assert path.exists()
    assert path.with_name("svara.log.1").exists()
    # A second rotation replaces the old .1 file instead of growing the set.
    for index in range(50):
        logger.info("scope", "y" * 20, {"index": index})
    assert path.with_name("svara.log.1").exists()
    assert not path.with_name("svara.log.2").exists()
