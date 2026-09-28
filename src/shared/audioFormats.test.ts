import {
  isSupportedAudioFile,
  getAudioExtension,
  SUPPORTED_IMPORT_EXTENSIONS,
} from './audioFormats';

describe('audioFormats', () => {
  it.each(SUPPORTED_IMPORT_EXTENSIONS)(
    'accepts %s as supported',
    (ext) => {
      expect(isSupportedAudioFile(`/path/to/file${ext}`)).toBe(true);
      expect(isSupportedAudioFile(`/path/to/file${ext.toUpperCase()}`)).toBe(true);
    }
  );

  it('rejects unsupported extensions', () => {
    expect(isSupportedAudioFile('/path/to/file.txt')).toBe(false);
    expect(isSupportedAudioFile('/path/to/file.mp4')).toBe(false);
    expect(isSupportedAudioFile('/path/to/file')).toBe(false);
  });

  it('returns the matched extension', () => {
    expect(getAudioExtension('/path/to/recording.flac')).toBe('.flac');
    expect(getAudioExtension('/path/to/VOICE.M4A')).toBe('.m4a');
    expect(getAudioExtension('/path/to/file.txt')).toBeUndefined();
  });
});
