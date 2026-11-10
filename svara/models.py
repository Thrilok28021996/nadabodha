"""Speech-model constants.

faster-whisper loads CTranslate2 models, so ``openai/whisper-large-v3-turbo``
(PyTorch weights) cannot be used directly. This is the maintained CT2
conversion of the same large-v3-turbo weights.
"""

from __future__ import annotations

DEFAULT_MODEL_REPO = "deepdml/faster-whisper-large-v3-turbo-ct2"
DEFAULT_MODEL_LABEL = "Whisper large-v3 turbo"

#: Values that only ever meant "the old built-in default". They are migrated
#: to DEFAULT_MODEL_REPO when settings are loaded, so existing installs pick
#: up the turbo model without the user re-saving settings.
LEGACY_DEFAULT_MODEL_REPOS = frozenset({"Systran/faster-whisper-base", ""})
