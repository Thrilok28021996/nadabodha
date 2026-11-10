"""Catppuccin palettes and the application stylesheet.

The UI uses Catppuccin Mocha (dark) by default and can switch to Latte (light)
from Settings → Appearance. Palette names follow the official Catppuccin spec
so colours are recognisable and consistent.
"""

from __future__ import annotations

from string import Template

PALETTES: dict[str, dict[str, str]] = {
    "mocha": {
        "rosewater": "#f5e0dc",
        "flamingo": "#f2cdcd",
        "pink": "#f5c2e7",
        "mauve": "#cba6f7",
        "red": "#f38ba8",
        "maroon": "#eba0ac",
        "peach": "#fab387",
        "yellow": "#f9e2af",
        "green": "#a6e3a1",
        "teal": "#94e2d5",
        "sky": "#89dceb",
        "sapphire": "#74c7ec",
        "blue": "#89b4fa",
        "lavender": "#b4befe",
        "text": "#cdd6f4",
        "subtext1": "#bac2de",
        "subtext0": "#a6adc8",
        "overlay2": "#9399b2",
        "overlay1": "#7f849c",
        "overlay0": "#6c7086",
        "surface2": "#585b70",
        "surface1": "#45475a",
        "surface0": "#313244",
        "base": "#1e1e2e",
        "mantle": "#181825",
        "crust": "#11111b",
    },
    "latte": {
        "rosewater": "#dc8a78",
        "flamingo": "#dd7878",
        "pink": "#ea76cb",
        "mauve": "#8839ef",
        "red": "#d20f39",
        "maroon": "#e64553",
        "peach": "#fe640b",
        "yellow": "#df8e1d",
        "green": "#40a02b",
        "teal": "#179299",
        "sky": "#04a5e5",
        "sapphire": "#209fb5",
        "blue": "#1e66f5",
        "lavender": "#7287fd",
        "text": "#4c4f69",
        "subtext1": "#5c5f77",
        "subtext0": "#6c6f85",
        "overlay2": "#7c7f93",
        "overlay1": "#8c8fa1",
        "overlay0": "#9ca0b0",
        "surface2": "#acb0be",
        "surface1": "#bcc0cc",
        "surface0": "#ccd0da",
        "base": "#eff1f5",
        "mantle": "#e6e9ef",
        "crust": "#dce0e8",
    },
}

FLAVOR_LABELS = {"mocha": "Catppuccin Mocha", "latte": "Catppuccin Latte"}

_STYLESHEET = Template(
    """
    QWidget {
        color: $text;
        font-size: 13px;
    }
    QMainWindow, QDialog, QMessageBox, QWidget#root {
        background: $base;
    }
    QFrame#card {
        background: $mantle;
        border: 1px solid $surface0;
        border-radius: 14px;
    }
    QLabel#title {
        font-size: 26px;
        font-weight: 700;
        color: $lavender;
    }
    QLabel#subtitle {
        color: $subtext0;
        font-size: 12px;
    }
    QLabel#status {
        font-size: 15px;
        font-weight: 600;
        color: $text;
    }
    QLabel#statusDot {
        background: $overlay0;
        border-radius: 5px;
    }
    QLabel#statusDot[state="recording"] { background: $red; }
    QLabel#statusDot[state="busy"] { background: $blue; }
    QLabel#statusDot[state="success"] { background: $green; }
    QLabel#statusDot[state="error"] { background: $peach; }
    QLabel#elapsed {
        font-family: "Menlo", "Monaco", monospace;
        color: $subtext0;
        background: $surface0;
        border-radius: 8px;
        padding: 3px 10px;
    }
    QLabel#hint {
        color: $overlay1;
        font-size: 11px;
    }
    QLabel#sectionTitle {
        color: $subtext0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 1px;
    }
    QLabel#meta {
        color: $overlay1;
        font-size: 11px;
    }
    QLabel#dialogHeading {
        font-size: 20px;
        font-weight: 700;
        color: $lavender;
    }
    QLabel#groupTitle {
        color: $subtext0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 1px;
    }
    QPushButton {
        background: $surface0;
        border: 1px solid $surface1;
        border-radius: 9px;
        padding: 7px 14px;
        color: $text;
    }
    QPushButton:hover { background: $surface1; }
    QPushButton:pressed { background: $surface2; }
    QPushButton:disabled {
        color: $overlay0;
        background: $surface0;
        border-color: $surface0;
    }
    QPushButton#primary {
        background: $mauve;
        border: none;
        color: $crust;
        font-weight: 700;
        padding: 10px 20px;
    }
    QPushButton#primary:hover { background: $lavender; }
    QPushButton#danger {
        background: $red;
        border: none;
        color: $crust;
        font-weight: 700;
        padding: 10px 20px;
    }
    QPushButton#danger:hover { background: $maroon; }
    QPushButton#ghost {
        background: transparent;
        border: 1px solid $surface1;
        color: $subtext1;
    }
    QPushButton#ghost:hover {
        background: $surface0;
        color: $text;
    }
    QPushButton#subtle {
        background: transparent;
        border: none;
        color: $overlay2;
        padding: 6px 10px;
    }
    QPushButton#subtle:hover {
        background: $surface0;
        color: $text;
    }
    QLineEdit, QPlainTextEdit {
        background: $surface0;
        border: 1px solid $surface1;
        border-radius: 9px;
        padding: 7px 10px;
        selection-background-color: $mauve;
        selection-color: $crust;
    }
    QLineEdit:hover, QPlainTextEdit:hover { border-color: $surface2; }
    QLineEdit:focus, QPlainTextEdit:focus { border-color: $lavender; }
    QPlainTextEdit#transcript, QPlainTextEdit#summary {
        background: transparent;
        border: none;
        padding: 0px;
        font-size: 13.5px;
    }
    QComboBox {
        background: $surface0;
        border: 1px solid $surface1;
        border-radius: 9px;
        padding: 6px 10px;
    }
    QComboBox:hover { border-color: $surface2; }
    QComboBox::drop-down { border: none; width: 22px; }
    QComboBox QAbstractItemView {
        background: $mantle;
        border: 1px solid $surface0;
        selection-background-color: $surface1;
        selection-color: $text;
    }
    QCheckBox { spacing: 8px; color: $subtext1; }
    QCheckBox::indicator {
        width: 16px;
        height: 16px;
        border-radius: 5px;
        border: 1px solid $surface2;
        background: $surface0;
    }
    QCheckBox::indicator:hover { border-color: $lavender; }
    QCheckBox::indicator:checked {
        background: $mauve;
        border-color: $mauve;
    }
    QSplitter::handle { background: transparent; width: 12px; }
    QScrollBar:vertical {
        background: transparent;
        width: 10px;
        margin: 2px;
    }
    QScrollBar::handle:vertical {
        background: $surface2;
        border-radius: 5px;
        min-height: 30px;
    }
    QScrollBar::handle:vertical:hover { background: $overlay0; }
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0px; }
    QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
    QScrollBar:horizontal { background: transparent; height: 10px; margin: 2px; }
    QScrollBar::handle:horizontal { background: $surface2; border-radius: 5px; min-width: 30px; }
    QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0px; }
    QStatusBar {
        background: $base;
        color: $overlay0;
        font-size: 11px;
        border-top: 1px solid $surface0;
    }
    QToolTip {
        background: $mantle;
        color: $text;
        border: 1px solid $surface1;
        padding: 5px 8px;
    }
    QMenu {
        background: $mantle;
        border: 1px solid $surface0;
        border-radius: 10px;
        padding: 6px;
    }
    QMenu::item {
        padding: 6px 18px;
        border-radius: 6px;
    }
    QMenu::item:selected { background: $surface0; }
    QScrollArea, QScrollArea > QWidget > QWidget {
        background: transparent;
        border: none;
    }
    QDialogButtonBox QPushButton { min-width: 90px; }
    """
)


def palette(flavor: str = "mocha") -> dict[str, str]:
    return PALETTES.get((flavor or "").lower(), PALETTES["mocha"])


def stylesheet(flavor: str = "mocha") -> str:
    colors = palette(flavor)
    return _STYLESHEET.substitute(**colors)


def apply_native_appearance(flavor: str = "mocha") -> None:
    """Match the macOS title bar and menus to the Catppuccin flavour."""
    import sys

    if sys.platform != "darwin":
        return
    try:
        from AppKit import NSApplication, NSAppearance

        name = "NSAppearanceNameAqua" if (flavor or "").lower() == "latte" else "NSAppearanceNameDarkAqua"
        appearance = NSAppearance.appearanceNamed_(name)
        NSApplication.sharedApplication().setAppearance_(appearance)
    except Exception:  # noqa: BLE001 - cosmetic only
        return
