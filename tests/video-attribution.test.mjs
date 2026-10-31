import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAttributedTitle } from '../lib/video-attribution.mjs';

test('YouTube 标题必须含完整游戏名，排除相似游戏与搜索串扰', () => {
  assert.equal(isAttributedTitle('BUILD and KILL Zombies in Roblox', '[🎃] Build A Zombie'), false);
  assert.equal(isAttributedTitle('THE LOCUST MARKET GOT EVEN SCARIER IN ROBLOX!', 'Merkado'), false);
  assert.equal(isAttributedTitle('I visited Supermerkado in Roblox', 'Merkado'), false);
  assert.equal(isAttributedTitle('PART 3 | Merkado [RELEASE]', 'Merkado'), true);
  assert.equal(isAttributedTitle('MENCARI KENDARAAN TERLANGKA! - Find a Ride, Roblox', '[🎃Update] Find a ride'), true);
});
