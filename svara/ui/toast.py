"""A small always-on-top card that says the dictation is ready to paste.

Shown when Svara could not paste into the focused app (no Accessibility
permission, secure input, or a failed keystroke). It never takes keyboard
focus: it is a tool window with ``WA_ShowWithoutActivating`` and, if AppKit
reports that Svara still came to the front, the previously active app is
reactivated so the user's Cmd+V lands where they were typing.
"""

from __future__ import annotations

from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QCursor, QGuiApplication
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from .banner import pin_window_to_every_space


def _snippet(text: str, limit: int = 180) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


class PasteToast(QWidget):
    """Non-activating card with the dictated text and a clipboard hint."""

    def __init__(
        self,
        text: str,
        message: str,
        *,
        show_accessibility_button: bool = False,
        on_open_accessibility=None,
        on_copy=None,
    ) -> None:
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setFixedWidth(420)

        card = QFrame(self)
        card.setObjectName("toastCard")
        self._title = QLabel("Dictation ready to paste")
        self._title.setObjectName("toastTitle")
        self._body = QLabel(message)
        self._body.setObjectName("toastBody")
        self._body.setWordWrap(True)
        self._preview = QLabel(f"“{_snippet(text)}”")
        self._preview.setObjectName("toastPreview")
        self._preview.setWordWrap(True)

        buttons = QHBoxLayout()
        buttons.setSpacing(8)
        if show_accessibility_button and on_open_accessibility is not None:
            accessibility = QPushButton("Open Accessibility Settings")
            accessibility.clicked.connect(on_open_accessibility)
            buttons.addWidget(accessibility)
        copy = QPushButton("Copy again")
        if on_copy is not None:
            copy.clicked.connect(on_copy)
            buttons.addWidget(copy)
        dismiss = QPushButton("Dismiss")
        dismiss.clicked.connect(self.close)
        buttons.addWidget(dismiss)
        buttons.addStretch(1)

        inner = QVBoxLayout(card)
        inner.setContentsMargins(16, 14, 16, 14)
        inner.setSpacing(8)
        inner.addWidget(self._title)
        inner.addWidget(self._body)
        inner.addWidget(self._preview)
        inner.addLayout(buttons)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(card)
        self.setStyleSheet(
            """
            #toastCard {
                background: rgba(22, 24, 30, 238);
                border: 1px solid rgba(255, 255, 255, 46);
                border-radius: 12px;
            }
            #toastTitle { color: #ffffff; font-size: 14px; font-weight: 600; }
            #toastBody { color: #c8ccd6; font-size: 12px; }
            #toastPreview { color: #8d93a1; font-size: 12px; }
            QPushButton {
                background: rgba(255, 255, 255, 22);
                color: #e7e9ee;
                border: 1px solid rgba(255, 255, 255, 40);
                border-radius: 7px;
                padding: 5px 10px;
                font-size: 12px;
            }
            QPushButton:hover { background: rgba(255, 255, 255, 40); }
            """
        )
        QTimer.singleShot(20_000, self.close)

    def set_message(self, message: str) -> None:
        self._body.setText(message)

    def show_near_cursor(self) -> None:
        previous = _frontmost_application()
        self.adjustSize()
        position = QCursor.pos()
        screen = QGuiApplication.screenAt(position) or QGuiApplication.primaryScreen()
        bounds = screen.availableGeometry()
        x = position.x() - self.width() // 2
        y = position.y() + 24
        if y + self.height() > bounds.bottom():
            y = position.y() - self.height() - 24
        x = max(bounds.left() + 8, min(x, bounds.right() - self.width() - 8))
        y = max(bounds.top() + 8, min(y, bounds.bottom() - self.height() - 8))
        self.move(x, y)
        # Same ordering rule as the status banner: pin while the window is not
        # yet ordered, then force it above the frontmost (possibly fullscreen)
        # app. Pinning after show() leaves it on Svara's own Space.
        pin_window_to_every_space(self)
        self.show()
        self.raise_()
        pin_window_to_every_space(self, order_front=True)
        # Showing even a non-activating tool window can bring the app forward
        # on some macOS builds; put the user's app back if that happened.
        QTimer.singleShot(150, lambda: _restore_frontmost(previous))


def _frontmost_application():
    try:
        from AppKit import NSWorkspace
    except Exception:  # noqa: BLE001 - AppKit is optional outside macOS
        return None
    return NSWorkspace.sharedWorkspace().frontmostApplication()


def _restore_frontmost(previous) -> None:
    if previous is None:
        return
    current = _frontmost_application()
    if current is None:
        return
    try:
        if current.processIdentifier() == previous.processIdentifier():
            return
        if current.processIdentifier() == __import__("os").getpid():
            previous.activateWithOptions_(2)  # NSApplicationActivateIgnoringOtherApps
    except Exception:  # noqa: BLE001 - focus restoration is best effort
        return
