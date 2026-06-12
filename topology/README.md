# topology/

Per-system **node-configuration trees** for the Node / Card-Bay grouping &
filtering feature. These are the `Net → Node → Card/Bay → Port` exports from
the config tool — they contain the full port inventory, so they are **local only**
(gitignored) and never committed.

## Format

Indentation is ignored; the hierarchy is driven by markers:

```
<Net name>
  <Node name> (ID: <n>)
    <Card name> (Bay <n>)
      <port name>          # or nested under "Media 1" / "Media 2" / "2022-7"
```

`Media 1/2`, `2022-7`, `Events` lines are structural and skipped. Every other
leaf is treated as a port and joined to the live RRCS ports **by name**.

## Wiring a system to a tree

Either add a `topology` path to the system's entry in `systems.json`:

```json
{ "id": "studio-a", "name": "Studio A", "host": "10.x.x.x", "topology": "topology/studio-a.txt" }
```

…or load it at runtime from the UI with the **+ Topology** button (per system).

Put each system's tree here, e.g. `topology/studio-a.txt`, `topology/studio-b.txt`,
`topology/control-room.txt`.
