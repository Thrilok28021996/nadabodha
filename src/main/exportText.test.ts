import fs from 'fs';
import os from 'os';
import path from 'path';
import { savePlainText } from './exportText';

describe('savePlainText', () => {
  it('writes text to a file', () => {
    const tmp = path.join(os.tmpdir(), `nadabodha-export-${Date.now()}.txt`);
    const result = savePlainText(tmp, 'hello world');
    expect(result.success).toBe(true);
    expect(result.filePath).toBe(tmp);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('hello world');
    fs.unlinkSync(tmp);
  });

  it('returns an error when path is empty', () => {
    const result = savePlainText('', 'hello');
    expect(result.success).toBe(false);
    expect(result.error).toBe('filePath and text are required');
  });

  it('returns an error for a non-writable directory', () => {
    const result = savePlainText('/nonexistent/dir/file.txt', 'hello');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
