// lib/print-diff.js — compare two parsed config prints and report what
// changed, GitHub-diff style: conferences added/removed, and within each
// conference the member panels added/removed and any Talk/Listen change.
//
// Identity: conference by name, member by panel name. A renamed conference
// therefore reads as one removed + one added (acceptable; refinable later).

// parsed print -> Map(confName -> { kind, alias, members: Map(panel -> {t,l}) })
function modelOf(parsed) {
  const m = new Map();
  for (const c of (parsed.conferences || [])) {
    const members = new Map();
    for (const k of c.keys || []) {
      if (!k.panel) continue;
      const e = members.get(k.panel) || { t: false, l: false };
      e.t = e.t || !!k.talk; e.l = e.l || !!k.listen;
      members.set(k.panel, e);
    }
    m.set(c.name, { kind: c.kind, alias: c.alias, members });
  }
  return m;
}

const byName = (a, b) => String(a).localeCompare(String(b));

function diffPrints(oldParsed, newParsed) {
  const A = modelOf(oldParsed), B = modelOf(newParsed);
  const names = [...new Set([...A.keys(), ...B.keys()])].sort(byName);
  const conferences = [];
  let confAdded = 0, confRemoved = 0, membersAdded = 0, membersRemoved = 0, dirChanged = 0;

  for (const name of names) {
    const a = A.get(name), b = B.get(name);

    if (!a) { // whole conference added
      confAdded++;
      const members = [...b.members].sort((x, y) => byName(x[0], y[0])).map(([panel, d]) => ({ panel, status: 'added', to: d }));
      membersAdded += members.length;
      conferences.push({ name, alias: b.alias, kind: b.kind, status: 'added', members });
      continue;
    }
    if (!b) { // whole conference removed
      confRemoved++;
      const members = [...a.members].sort((x, y) => byName(x[0], y[0])).map(([panel, d]) => ({ panel, status: 'removed', from: d }));
      membersRemoved += members.length;
      conferences.push({ name, alias: a.alias, kind: a.kind, status: 'removed', members });
      continue;
    }

    // both present — diff member panels
    const panels = [...new Set([...a.members.keys(), ...b.members.keys()])].sort(byName);
    const members = [];
    for (const panel of panels) {
      const da = a.members.get(panel), db = b.members.get(panel);
      if (!da) { members.push({ panel, status: 'added', to: db }); membersAdded++; }
      else if (!db) { members.push({ panel, status: 'removed', from: da }); membersRemoved++; }
      else if (da.t !== db.t || da.l !== db.l) { members.push({ panel, status: 'changed', from: da, to: db }); dirChanged++; }
      // unchanged members are omitted
    }
    if (members.length) conferences.push({ name, alias: b.alias, kind: b.kind, status: 'changed', members });
  }

  return {
    summary: { confAdded, confRemoved, membersAdded, membersRemoved, dirChanged, changedConferences: conferences.length },
    conferences, // only added/removed/changed; unchanged omitted
  };
}

module.exports = { diffPrints, modelOf };
