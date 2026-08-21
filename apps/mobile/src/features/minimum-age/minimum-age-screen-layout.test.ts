import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const screen = readFileSync(
  join(process.cwd(), 'src/features/minimum-age/minimum-age-screen.tsx'),
  'utf8',
);

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const statusScreen = sliceBetween(
  screen,
  'export function MinimumAgeStatusScreen',
  '\nconst styles = StyleSheet.create',
);
const styleSheet = screen.slice(screen.indexOf('const styles = StyleSheet.create'));
const statusTitleStyle = sliceBetween(
  styleSheet,
  '  statusTitle: {',
  '\n  },',
);

describe('minimum-age status screen title layout', () => {
  it('uses native orphan-resistant line breaking without truncating accessible text', () => {
    expect(statusScreen).toContain('lineBreakStrategyIOS="standard"');
    expect(statusScreen).toContain('textBreakStrategy="balanced"');
    expect(statusScreen).toContain('styles.statusTitle');
    expect(statusScreen).not.toContain('numberOfLines=');
    expect(statusScreen).not.toContain('ellipsizeMode=');
    expect(statusScreen).not.toContain('adjustsFontSizeToFit');
  });

  it('constrains the status title itself to the available readable width', () => {
    expect(statusTitleStyle).toContain("width: '100%'");
    expect(statusTitleStyle).toContain('maxWidth: 520');
  });
});
