jest.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: jest.fn(),
    askForMediaAccess: jest.fn(),
  },
}));

import { systemPreferences } from 'electron';
import {
  MICROPHONE_DENIED_MESSAGE,
  ensureMicrophonePermission,
  friendlyRecordingFailure,
  isMicrophoneCaptureFailure,
} from './micPermission';

interface MockedSystemPreferences {
  getMediaAccessStatus: jest.Mock;
  askForMediaAccess: jest.Mock;
}

const sp = systemPreferences as unknown as MockedSystemPreferences;

const AVFOUNDATION_DENIAL_STDERR = [
  '[AVFoundation indev @ 0x7f] Failed to open device: Default',
  'avfoundation: cannot use MacBook Air Microphone',
  'Error opening input: :default',
].join('\n');

beforeEach(() => {
  sp.getMediaAccessStatus.mockReset();
  sp.askForMediaAccess.mockReset();
});

describe('ensureMicrophonePermission', () => {
  it('grants without prompting when the OS already granted access', async () => {
    sp.getMediaAccessStatus.mockReturnValue('granted');

    const result = await ensureMicrophonePermission();

    expect(result.granted).toBe(true);
    expect(sp.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('denies without prompting when access is denied', async () => {
    sp.getMediaAccessStatus.mockReturnValue('denied');

    const result = await ensureMicrophonePermission();

    expect(result.granted).toBe(false);
    // A denial must never trigger another prompt; it must block the recorder.
    expect(sp.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('denies when access is restricted', async () => {
    sp.getMediaAccessStatus.mockReturnValue('restricted');

    expect((await ensureMicrophonePermission()).granted).toBe(false);
  });

  it('asks the OS when access is not yet determined and grants on consent', async () => {
    sp.getMediaAccessStatus.mockReturnValue('not-determined');
    sp.askForMediaAccess.mockResolvedValue(true);

    const result = await ensureMicrophonePermission();

    expect(result.granted).toBe(true);
    expect(sp.askForMediaAccess).toHaveBeenCalledWith('microphone');
  });

  it('denies when the OS request is refused', async () => {
    sp.getMediaAccessStatus.mockReturnValue('not-determined');
    sp.askForMediaAccess.mockResolvedValue(false);

    const result = await ensureMicrophonePermission();

    expect(result.granted).toBe(false);
    expect(sp.askForMediaAccess).toHaveBeenCalledWith('microphone');
  });

  it('denies when the permission API is unavailable (throws)', async () => {
    sp.getMediaAccessStatus.mockImplementation(() => {
      throw new Error('TCC query failed');
    });

    expect((await ensureMicrophonePermission()).granted).toBe(false);
  });
});

describe('isMicrophoneCaptureFailure', () => {
  it('detects the avfoundation capture-device failure', () => {
    expect(isMicrophoneCaptureFailure(AVFOUNDATION_DENIAL_STDERR)).toBe(true);
  });

  it('detects a failed avfoundation device open without the word "cannot"', () => {
    expect(
      isMicrophoneCaptureFailure(
        '[AVFoundation indev @ 0x7f] Failed to open device: Default'
      )
    ).toBe(true);
  });

  it('ignores unrelated ffmpeg failures', () => {
    expect(isMicrophoneCaptureFailure('Conversion failed!')).toBe(false);
  });

  it('ignores avfoundation output that shows no failure', () => {
    expect(isMicrophoneCaptureFailure('avfoundation: recording from device')).toBe(false);
  });

  it('handles empty stderr', () => {
    expect(isMicrophoneCaptureFailure('')).toBe(false);
  });
});

describe('friendlyRecordingFailure', () => {
  it('leads with the guidance and keeps the Recording failed detail as secondary', () => {
    const detail = 'Recording failed: avfoundation: cannot use MacBook Air Microphone';

    const message = friendlyRecordingFailure(detail, AVFOUNDATION_DENIAL_STDERR);

    expect(message.startsWith(MICROPHONE_DENIED_MESSAGE)).toBe(true);
    expect(message).toContain(detail);
  });

  it('returns a non-capture failure unchanged', () => {
    const detail = 'Recording failed: ffmpeg produced no recording file';

    expect(friendlyRecordingFailure(detail, 'Conversion failed!')).toBe(detail);
    expect(friendlyRecordingFailure(detail, '')).toBe(detail);
  });

  it('never prefixes the guidance twice', () => {
    const alreadyGuided = `${MICROPHONE_DENIED_MESSAGE} Recording failed: detail`;

    expect(friendlyRecordingFailure(alreadyGuided, AVFOUNDATION_DENIAL_STDERR)).toBe(
      alreadyGuided
    );
  });

  it('uses the exact actionable guidance string', () => {
    expect(MICROPHONE_DENIED_MESSAGE).toBe(
      'Microphone access denied. Allow it in System Settings > Privacy & Security > Microphone, then try again.'
    );
  });
});
