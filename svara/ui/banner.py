"""A small always-on-top banner for dictation state.

Dictation happens in other apps, so the window is usually not visible when a
take stops. This banner appears when transcription starts and flips to the
outcome, so "did my stop register?" is answerable without switching apps.

It never takes keyboard focus (tool window + ``WA_ShowWithoutActivating``), and
it never intercepts clicks inside the app the user is typing into.
"""

from __future__ import annotations

from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QCursor, QGuiApplication
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QVBoxLayout, QWidget

BUSY = "busy"
SUCCESS = "success"
ERROR = "error"

_DOT_COLORS = {BUSY: "#cba6f7", SUCCESS: "#a6e3a1", ERROR: "#f38ba8"}


def pin_window_to_every_space(widget: QWidget, *, order_front: bool = False) -> None:
    """Order a macOS window above other apps, on every Space and fullscreen.

    A plain Qt.Tool window is ordered on Svara's own Space, so a maximised or
    fullscreen app on another Space hides it. AppKit collection behaviour is the
    only way to join every Space and sit above a fullscreen window.

    This must run *before* the window is ordered on screen. Setting the
    collection behaviour on a window macOS has already placed does not move it
    into the active fullscreen Space, which is why the banner used to appear on
    ordinary desktops but never over a fullscreen app. ``order_front`` adds the
    matching ``orderFrontRegardless()``, because Qt's ``raise_()`` respects the
    app's own ordering rules and will not put a window over another app's
    fullscreen Space.
    """
    application = QGuiApplication.instance()
    if application is None or application.platformName() != "cocoa":
        # winId() is not an NSView on offscreen/minimal platforms; touching it
        # through PyObjC segfaults.
        return
    try:
        import objc
        from AppKit import (
            NSStatusWindowLevel,
            NSWindowCollectionBehaviorCanJoinAllSpaces,
            NSWindowCollectionBehaviorFullScreenAuxiliary,
            NSWindowCollectionBehaviorIgnoresCycle,
            NSWindowCollectionBehaviorStationary,
        )
    except Exception:  # noqa: BLE001 - non-macOS or PyObjC missing
        return
    try:
        view = objc.objc_object(c_void_p=int(widget.winId()))
        window = view.window()
        if window is None:
            return
        behaviour = (
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorIgnoresCycle
        )
        window.setCollectionBehavior_(behaviour)
        window.setLevel_(NSStatusWindowLevel)
        window.setHidesOnDeactivate_(False)
        window.setCanHide_(False)
        if order_front:
            window.orderFrontRegardless()
    except Exception:  # noqa: BLE001 - cosmetic; never break dictation
        return


class StatusBanner(QWidget):
    """Non-activating pill that shows what dictation is doing right now."""

    def __init__(self) -> None:
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        # Qt-only flag: keep a tool window visible when the app is not active.
        attribute = getattr(Qt.WidgetAttribute, "WA_MacAlwaysShowToolWindow", None)
        if attribute is not None:
            self.setAttribute(attribute, True)

        card = QFrame(self)
        card.setObjectName("bannerCard")
        self._dot = QLabel("●")
        self._dot.setObjectName("bannerDot")
        self._text = QLabel("")
        self._text.setObjectName("bannerText")

        row = QHBoxLayout(card)
        row.setContentsMargins(14, 8, 16, 8)
        row.setSpacing(9)
        row.addWidget(self._dot)
        row.addWidget(self._text)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(card)
        self.setStyleSheet(
            """
            #bannerCard {
                background: rgba(24, 24, 37, 240);
                border: 1px solid rgba(69, 71, 90, 220);
                border-radius: 14px;
            }
            #bannerText { color: #cdd6f4; font-size: 12px; }
            """
        )

        self._pulse = QTimer(self)
        self._pulse.setInterval(420)
        self._pulse.timeout.connect(self._tick)
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self.hide)

    # ------------------------------------------------------------------ api
    def show_message(self, text: str, kind: str = BUSY, timeout_ms: int = 0) -> None:
        """Show ``text``; a positive timeout hides the banner after that delay."""
        self._text.setText(text)
        color = _DOT_COLORS.get(kind, _DOT_COLORS[BUSY])
        self._dot.setStyleSheet(f"color: {color}; font-size: 11px;")
        self._pulse.stop()
        self._dot.setText("●")
        if kind == BUSY:
            self._pulse.start()
        self._hide_timer.stop()
        if timeout_ms > 0:
            self._hide_timer.start(timeout_ms)
        self._place()
        # Pin before ordering: macOS will otherwise place the window on Svara's
        # own Space, and setting the behaviour afterwards does not move it into
        # the active fullscreen Space.
        self._pin_to_every_space()
        self.show()
        self.raise_()
        # Re-assert, then order above whatever app currently owns the screen.
        self._pin_to_every_space(order_front=True)

    def _pin_to_every_space(self, *, order_front: bool = False) -> None:
        """Make the banner float over other apps, their windows and their spaces."""
        pin_window_to_every_space(self, order_front=order_front)

    def _tick(self) -> None:
        self._dot.setText("○" if self._dot.text() == "●" else "●")

    def _place(self) -> None:
        self.adjustSize()
        screen = QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()
        bounds = screen.availableGeometry()
        x = bounds.center().x() - self.width() // 2
        y = bounds.top() + 28
        self.move(max(bounds.left() + 8, x), y)
