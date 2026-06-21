import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

const REQUIRED = [
  '## When to use',
  '## Process',
  '## .NET / Azure checks',
  '## Red flags',
  '## Example',
];

const skillDirs = readdirSync('skills').filter((d) => statSync(join('skills', d)).isDirectory());

test('the collection has skills', () => {
  assert.ok(skillDirs.length >= 12, `expected >= 12 skills, found ${skillDirs.length}`);
});

for (const name of skillDirs) {
  test(`skill ${name} is well-formed`, () => {
    const path = join('skills', name, 'SKILL.md');
    assert.ok(existsSync(path), `${name}: missing SKILL.md`);
    const text = readFileSync(path, 'utf8');
    const { data } = parseFrontmatter(text);
    assert.equal(data.name, name, `${name}: frontmatter name must equal the folder name`);
    assert.ok(
      data.description && data.description.startsWith('Use when'),
      `${name}: description must start with "Use when"`,
    );
    let last = -1;
    for (const section of REQUIRED) {
      const idx = text.indexOf(`\n${section}`);
      assert.notEqual(idx, -1, `${name}: missing section "${section}"`);
      assert.ok(idx > last, `${name}: section "${section}" is out of order`);
      last = idx;
    }
    assert.ok(
      existsSync(join('examples', name, 'README.md')),
      `${name}: missing examples/${name}/README.md`,
    );
    assert.match(text, new RegExp(`examples/${name}/`), `${name}: Example must link to examples/${name}/`);
  });
}

test('manifests agree on version 0.2.0 and the skills path', () => {
  const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
  assert.equal(plugin.skills, './skills/');
  assert.equal(plugin.version, '0.2.0');
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'plugin not listed in marketplace');
  assert.equal(entry.version, plugin.version);
});
