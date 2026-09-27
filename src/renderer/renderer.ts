import { ElectronApi } from '../preload/preload';
import { TranscriptionEvent } from '../shared/ipc';

declare global {
  interface Window {
    electronAPI: ElectronApi;
  }
}

const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const stopRecordBtn = document.getElementById('stopRecordBtn') as HTMLButtonElement;
const importBtn = document.getElementById('importBtn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const statusText = document.getElementById('statusText') as HTMLParagraphElement;
const progressBar = document.getElementById('progressBar') as HTMLProgressElement;
const errorText = document.getElementById('errorText') as HTMLParagraphElement;
const transcriptArea = document.getElementById('transcriptArea') as HTMLTextAreaElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;

let currentText = '';

function updateStatus(event: TranscriptionEvent): void {
  statusText.textContent = `Status: ${event.status}`;
  errorText.hidden = true;

  if (event.status === 'recording' || event.status === 'transcribing') {
    recordBtn.disabled = true;
    stopRecordBtn.disabled = event.status === 'transcribing';
    importBtn.disabled = true;
    cancelBtn.disabled = false;
    copyBtn.disabled = true;
    saveBtn.disabled = true;
  } else if (event.status === 'completed') {
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    importBtn.disabled = false;
    cancelBtn.disabled = true;
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    currentText = event.text || '';
    transcriptArea.value = currentText;
  } else if (event.status === 'error') {
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    importBtn.disabled = false;
    cancelBtn.disabled = true;
    copyBtn.disabled = true;
    saveBtn.disabled = true;
    errorText.textContent = event.error || 'Unknown error';
    errorText.hidden = false;
  } else {
    // idle / cancelled
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    importBtn.disabled = false;
    cancelBtn.disabled = true;
    copyBtn.disabled = !currentText;
    saveBtn.disabled = !currentText;
  }

  if (event.status === 'transcribing' && typeof event.progress === 'number') {
    progressBar.value = event.progress;
    progressBar.hidden = false;
  } else {
    progressBar.value = 0;
    progressBar.hidden = true;
  }
}

recordBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.startRecording();
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

stopRecordBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.stopRecording();
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

importBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    await window.electronAPI.importAudio(file.path);
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

cancelBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.cancelTranscription();
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.copyTranscript(transcriptArea.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

saveBtn.addEventListener('click', async () => {
  try {
    const filePath = await window.electronAPI.requestSavePath?.();
    if (!filePath) return;
    const result = await window.electronAPI.saveTranscript({
      filePath,
      text: transcriptArea.value,
    });
    if (!result.success) {
      updateStatus({ status: 'error', error: result.error || 'Save failed' });
    }
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

window.electronAPI.onTranscriptionEvent((event) => {
  updateStatus(event);
});

window.electronAPI.requestStatus().then((status) => {
  updateStatus({ status: status.status as TranscriptionEvent['status'], text: status.text });
}).catch(() => {
  updateStatus({ status: 'idle' });
});
