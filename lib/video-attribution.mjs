import { cleanGameName } from './own-games.mjs';
import { normName } from './tool-demand.mjs';

/** YouTube 会改拼写、吞词并混入相似游戏；只认标题里的完整游戏名。 */
export function isAttributedTitle(title, game) {
  const name = normName(cleanGameName(game));
  return Boolean(name) && ` ${normName(title)} `.includes(` ${name} `);
}
