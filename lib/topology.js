// lib/topology.js — parse a controller "node configuration tree" (Net → Node →
// Card/Bay → Port) into a lookup that lets the viewer group/filter ports by
// node and card. Joined to live RRCS data BY PORT NAME (the tree's leaf names
// are the port LongNames).
//
// Expected text format (indentation is ignored; markers drive the hierarchy):
//   <Net name>
//     <Node name> (ID: <n>)
//       <Card name> (Bay <n>)[(used/total)]
//         <port name>            # or nested under "Media 1" / "Media 2" / "2022-7"
//
// Lines that are "Media 1/2", "2022-7", "Events" etc. are structural and skipped.

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const SKIP = new Set(['media 1', 'media 2', '2022-7', 'events']);

function parseTopology(text) {
  const byName = new Map();              // norm(portName) -> { node, nodeId, card, bay }
  const nodes = [];                       // ordered [{ id, name, cards: [{ key, name, bay }] }]
  const nodeById = new Map();
  let curNode = null, curCard = null, portCount = 0;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;

    const nodeM = t.match(/^(.*?)\(ID:\s*(\d+)\)\s*$/);
    if (nodeM) {
      curNode = { id: nodeM[2].trim(), name: nodeM[1].trim() || ('Node ' + nodeM[2].trim()), cards: [] };
      curCard = null;
      if (!nodeById.has(curNode.id)) { nodeById.set(curNode.id, curNode); nodes.push(curNode); }
      else curNode = nodeById.get(curNode.id);
      continue;
    }
    const cardM = t.match(/^(.*?)\(Bay\s*(\d+)\)/);
    if (cardM && curNode) {
      const bay = 'Bay ' + cardM[2].trim();
      curCard = { key: bay + ' · ' + (cardM[1].trim() || ''), name: cardM[1].trim(), bay };
      if (!curNode.cards.some((c) => c.key === curCard.key)) curNode.cards.push(curCard);
      continue;
    }
    if (SKIP.has(t.toLowerCase())) continue;
    // Otherwise it's a port leaf — record it under the current node + card.
    if (curNode && curCard) {
      byName.set(norm(t), { node: curNode.name, nodeId: curNode.id, card: curCard.name, bay: curCard.bay, fullName: t });
      portCount++;
    }
  }

  const names = [...byName.values()].map((v) => v.fullName);
  return { byName, nodes, names, stats: { nodes: nodes.length, cards: nodes.reduce((a, n) => a + n.cards.length, 0), ports: portCount } };
}

// Look up a port's node/card/bay by its (live) name.
function locate(topology, name) {
  if (!topology) return null;
  return topology.byName.get(norm(name)) || null;
}

module.exports = { parseTopology, locate, norm };

// CLI: node lib/topology.js <tree.txt>
if (require.main === module) {
  const fs = require('fs');
  const f = process.argv[2];
  if (!f) { console.error('usage: node lib/topology.js <tree.txt>'); process.exit(1); }
  const topo = parseTopology(fs.readFileSync(f, 'utf8'));
  console.log('stats:', JSON.stringify(topo.stats));
  console.log('nodes:');
  for (const n of topo.nodes) console.log(`  [${n.id}] ${n.name} — ${n.cards.length} cards`);
  console.log('sample ports:');
  let i = 0;
  for (const [k, v] of topo.byName) { console.log(`  ${k} -> node "${v.node}" / ${v.bay} ${v.card}`); if (++i >= 8) break; }
}
