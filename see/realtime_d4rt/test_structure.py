# Concern: freeze the structural-honesty invariants so a later refactor cannot erode them | Non-concern: GPU numerics, which the demo measures | IO: none (pure introspection)

from __future__ import annotations

import inspect

from realtime_d4rt.engine import Engine
from realtime_d4rt.feeder import PairFeeder


def test_reconstruct_takes_two_frames_only() -> None:
    params = list(inspect.signature(Engine.reconstruct).parameters)
    assert params == ["self", "frame_a", "frame_b"], params


def test_feeder_buffer_is_bounded_to_gap_plus_one() -> None:
    feeder = PairFeeder("unused.mp4", gap=8)
    assert feeder._buffer.maxlen == feeder.gap + 1


def test_reconstruct_refuses_outside_session() -> None:
    engine = Engine.__new__(Engine)
    engine._in_session = False
    try:
        engine.reconstruct(None, None)
    except RuntimeError as exc:
        assert "session" in str(exc)
    else:
        raise AssertionError("reconstruct() must refuse to run outside a session")


if __name__ == "__main__":
    test_reconstruct_takes_two_frames_only()
    test_feeder_buffer_is_bounded_to_gap_plus_one()
    test_reconstruct_refuses_outside_session()
    print("structural invariants hold")
