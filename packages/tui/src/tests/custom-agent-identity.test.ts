import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customAgentFile, customAgentId } from '../custom-agents.js';

test('identity keeps the host and the full relative path; same name on two hosts is two ids', () => {
  assert.equal(customAgentId({ source: 'opencode', name: 'team/scout' }), 'opencode:team/scout');
  assert.notEqual(customAgentId({ source: 'claude', name: 'scout' }), customAgentId({ source: 'opencode', name: 'scout' }));
});

test('customAgentFile gives each host its own file path', () => {
  assert.equal(customAgentFile({ source: 'claude', name: 'scout' }), '.claude/agents/scout.md');
  assert.equal(customAgentFile({ source: 'opencode', name: 'team/scout' }), '.opencode/agents/team/scout.md');
  assert.equal(customAgentFile({ source: 'agy', name: 'helper' }), '.agents/agents/helper/agent.md');
});
