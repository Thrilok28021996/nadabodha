"""Library dialog: browse recordings, transcripts and summaries on disk."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..library import LibraryItem, scan_library


class LibraryDialog(QDialog):
    open_transcript = Signal(str)
    transcribe_requested = Signal(str)
    summarize_requested = Signal(str)

    def __init__(self, root: Path, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._root = Path(root)
        self._items: list[LibraryItem] = []
        self.setWindowTitle("Library")
        self.setMinimumSize(760, 480)

        heading = QLabel("Library")
        heading.setObjectName("dialogHeading")
        self._filter = QLineEdit()
        self._filter.setPlaceholderText("Filter by name…")
        self._filter.textChanged.connect(self._apply_filter)

        self._table = QTableWidget(0, 4)
        self._table.setHorizontalHeaderLabels(["Kind", "Name", "When", "Detail"])
        self._table.verticalHeader().setVisible(False)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.setAlternatingRowColors(False)
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.setColumnWidth(0, 100)
        self._table.setColumnWidth(2, 170)
        self._table.itemSelectionChanged.connect(self._update_actions)
        self._table.itemDoubleClicked.connect(lambda _item: self._open_selected())

        self._open_button = QPushButton("Open transcript")
        self._open_button.clicked.connect(self._open_selected)
        self._transcribe_button = QPushButton("Transcribe recording")
        self._transcribe_button.clicked.connect(self._transcribe_selected)
        self._summarize_button = QPushButton("Summarize")
        self._summarize_button.clicked.connect(self._summarize_selected)
        self._reveal_button = QPushButton("Show in Finder")
        self._reveal_button.clicked.connect(self._reveal_selected)
        refresh = QPushButton("Refresh")
        refresh.clicked.connect(self.reload)
        close = QPushButton("Close")
        close.clicked.connect(self.accept)

        buttons = QHBoxLayout()
        buttons.setSpacing(8)
        buttons.addWidget(self._open_button)
        buttons.addWidget(self._transcribe_button)
        buttons.addWidget(self._summarize_button)
        buttons.addWidget(self._reveal_button)
        buttons.addStretch(1)
        buttons.addWidget(refresh)
        buttons.addWidget(close)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 16)
        layout.setSpacing(12)
        layout.addWidget(heading)
        layout.addWidget(self._filter)
        layout.addWidget(self._table, 1)
        layout.addLayout(buttons)

        self.reload()

    def reload(self) -> None:
        self._items = scan_library(self._root)
        self._table.setRowCount(len(self._items))
        for row, item in enumerate(self._items):
            values = (item.kind, item.name, item.when.strftime("%Y-%m-%d %H:%M"), item.detail)
            for column, value in enumerate(values):
                cell = QTableWidgetItem(value)
                cell.setData(Qt.ItemDataRole.UserRole, str(item.path))
                self._table.setItem(row, column, cell)
        self._apply_filter(self._filter.text())
        self._update_actions()

    def _apply_filter(self, text: str) -> None:
        needle = text.strip().lower()
        for row in range(self._table.rowCount()):
            name = self._table.item(row, 1).text().lower()
            self._table.setRowHidden(row, bool(needle) and needle not in name)

    def _selected_item(self) -> LibraryItem | None:
        rows = self._table.selectionModel().selectedRows() if self._table.selectionModel() else []
        if not rows:
            return None
        return self._items[rows[0].row()]

    def _update_actions(self) -> None:
        item = self._selected_item()
        self._open_button.setEnabled(bool(item and item.kind in {"Transcript", "Summary"}))
        self._transcribe_button.setEnabled(bool(item and item.kind == "Recording"))
        self._summarize_button.setEnabled(bool(item and item.kind == "Transcript"))

    def _open_selected(self) -> None:
        item = self._selected_item()
        if item is not None and item.kind in {"Transcript", "Summary"}:
            self.open_transcript.emit(str(item.path))

    def _transcribe_selected(self) -> None:
        item = self._selected_item()
        if item is not None and item.kind == "Recording":
            self.transcribe_requested.emit(str(item.path))

    def _summarize_selected(self) -> None:
        item = self._selected_item()
        if item is not None and item.kind == "Transcript":
            self.summarize_requested.emit(str(item.path))

    def _reveal_selected(self) -> None:
        item = self._selected_item()
        if item is None:
            return
        import subprocess
        import sys

        try:
            if sys.platform == "darwin":
                subprocess.run(["open", "-R", str(item.path)], check=False, timeout=5)
            elif sys.platform.startswith("win"):
                subprocess.run(["explorer", "/select,", str(item.path)], check=False, timeout=5)
            else:
                subprocess.run(["xdg-open", str(item.path.parent)], check=False, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return
