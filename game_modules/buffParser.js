import buffData from '../discord_modules/buff_data.json' with { type: 'json' };

// 2. Create a more efficient, reverse look-up map (ID -> Name).
// We do this only ONCE when the module is first loaded, which is great for performance.
const buffIdToNameMap = {};
for (const buffName in buffData) {
  const buffId = buffData[buffName];
  buffIdToNameMap[buffId] = buffName;
}

export function getBuffNameById(id) {
  // 3. Now, looking up the name is super fast and easy.
  return buffIdToNameMap[id] || 'Unknown Buff';
}
