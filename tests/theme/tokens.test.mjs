import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTheme } from '@agentui/theme';

function contrast(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const appearance of ['light', 'dark']) {
  test(`${appearance} text and action colors have accessible contrast`, () => {
    const { colors } = createTheme({ appearance });
    for (const background of ['canvas', 'surface', 'raised']) {
      for (const foreground of ['text', 'muted']) {
        assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${foreground} on ${background}`);
      }
      for (const foreground of ['focus', 'controlBorder']) {
        assert.ok(contrast(colors[foreground], colors[background]) >= 3, `${foreground} on ${background}`);
      }
    }
    for (const [foreground, background] of [['onAccent', 'accent'], ['onDanger', 'danger']]) {
      assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${foreground} on ${background}`);
    }
  });
}

test('module overrides inherit without mutating their parent or siblings', () => {
  const parent = createTheme({ appearance: 'dark', colors: { accent: '#c4b5fd' } });
  const child = createTheme({ colors: { surface: '#181821' }, reducedMotion: true }, parent);
  assert.equal(child.colors.accent, '#c4b5fd');
  assert.equal(child.appearance, 'dark');
  assert.equal(child.colors.surface, '#181821');
  assert.equal(child.motion.quick, 0);
  assert.equal(child.motion.standard, 0);
  assert.equal(parent.colors.surface, '#1d2027');
  assert.ok(parent.motion.quick > 0);
  assert.equal(createTheme({}, parent).colors.surface, parent.colors.surface);
  const switched = createTheme({ appearance: 'light' }, parent);
  assert.equal(switched.colors.surface, '#ffffff');
});
