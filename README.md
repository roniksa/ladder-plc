# ladder-plc

Build PLC ladder logic from a chat interface. An MCP server gives the model tools to declare tags, write rungs, validate, simulate and export; a browser front end shows the ladder with live power flow and lets you operate inputs and edit rungs.

- **Standard:** IEC 61131-3 ladder diagram (LD)
- **Export:** PLCopen XML (TC6 v2.01), a complete project with one program, a configuration and a cyclic task
- **No hardware needed:** the scan-cycle simulator runs the logic in the browser and headlessly for tests
- **Two ways to run it:** locally with the MCP server and chat, or as a static site on GitHub Pages with the editor and simulator only

## Quick start

```bash
npm install
```

```bash
npm run build
```

```bash
npm run web
```

Then open http://localhost:4790. The folder ships with a demo project (`project.ladder.json`, a filling station).

A second example, `winder.ladder.json`, is a center winder for plastic film with taper tension, built through the MCP tools. To open it instead:

```bash
LADDER_PORT=4792 node dist/server/web.js winder.ladder.json
```

## Connect it to Claude

**Claude Code:** `.mcp.json` in this folder registers the server. Start Claude Code here and approve the `ladder-plc` server.

**Claude Desktop or another MCP client:** add this to the client's MCP configuration, with the absolute path to this folder:

```json
{
  "mcpServers": {
    "ladder-plc": {
      "command": "node",
      "args": ["/absolute/path/to/ladder_plc/dist/server/mcp.js"],
      "env": { "LADDER_PROJECT": "/absolute/path/to/ladder_plc/project.ladder.json" }
    }
  }
}
```

The MCP server also serves the simulator at http://localhost:4790 while it runs. Chat edits and browser edits share one project file, so the browser updates as the model works.

| Setting | Default | Meaning |
|---|---|---|
| `LADDER_PROJECT` | `project.ladder.json` in the working directory | Project file |
| `LADDER_PORT` | `4790` | Simulator port |

## Host it on GitHub Pages

The editor and simulator also run as a static site with no server. The project is kept in the visitor's browser (local storage), and the File menu opens and saves project files and loads the demo. The site has no chat and no MCP server; those need the local setup above. A project file saved from the site opens locally and the other way round, because both use the same `.ladder.json` format.

```bash
npm run preview:pages
```

This builds the site into `site/` and serves it at http://localhost:4791/ladder-plc/, under a sub-path the way GitHub Pages does.

To publish:

1. Create a repository on GitHub and push this folder to its `main` branch.
2. In the repository, open Settings > Pages and set Source to **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` runs the tests, builds `site/` and deploys it on every push to `main`. The address is `https://<user>.github.io/<repository>/`.

What a visitor builds stays in their own browser. Nothing is uploaded, and two visitors do not see each other's projects.

## Tools

| Tool | Purpose |
|---|---|
| `get_project` | Tags, rungs as text and as a diagram, validation result |
| `new_project`, `set_project_info` | Start or describe a project |
| `set_tags`, `rename_tag`, `remove_tag` | Declare signals with addresses and field wiring |
| `add_rungs`, `update_rung`, `remove_rung`, `move_rung` | Edit the logic |
| `validate_project` | Errors and warnings |
| `simulate` | Run a scenario: set inputs, let time pass, check expected values |
| `export_plcopen` | Write the PLCopen XML file |
| `open_simulator` | Address of the live front end |
| `ladder_reference` | Rung syntax and block list |

## Rung text syntax

```
(start_pb | motor) & stop_pb & overload_ok -> motor, run_lamp
```

| Text | Element |
|---|---|
| `a & b` | Series (AND) |
| `a \| b` | Parallel branch (OR) |
| `tag` | Normally open contact |
| `!tag` | Normally closed contact |
| `P(tag)`, `N(tag)` | Rising / falling edge contact |
| `-> tag`, `-> !tag` | Coil, negated coil |
| `-> S(tag)`, `-> R(tag)` | Set (latch), reset (unlatch) |
| `TON(T1, T#5s)` | Inline block; power flows in, the main output continues the rung |

Blocks: `TON`, `TOF`, `TP`, `CTU`, `CTD`, `R_TRIG`, `F_TRIG`, `SR`, `RS`, `EQ`, `NE`, `GT`, `GE`, `LT`, `LE`, `ADD`, `SUB`, `MUL`, `DIV`, `MOVE`.
Data types: `BOOL`, `INT`, `DINT`, `REAL`, `TIME`.

### Field wiring

A contact tests the input **bit**, not the device. Stop buttons and overload contacts are wired normally closed so a broken wire stops the machine: their bit is 1 when healthy. Declare them with field wiring `NC` and use a plain (normally open) contact in the logic. The simulator starts NC-wired inputs at 1, and pressing one drives its bit to 0.

## Using the export

- **CODESYS:** Project > Import PLCopenXML.
- **OpenPLC Editor / Beremiz:** a project is a folder containing `plc.xml`. Create a project, close it, and replace its `plc.xml` with the exported file.

## Layout

```
src/core     model, rung parser, validator, simulator, layout, PLCopen export (no Node or DOM dependencies)
src/server   MCP server, HTTP API, project file store
src/web      browser front end (backend.ts picks the local server or browser storage)
scripts      static site build and preview for GitHub Pages
src/test     unit tests and an end-to-end MCP test (npm test)
public       page shell and styles
```

## Limits

- One program POU; no structured text, function block diagram or user-defined blocks.
- The export validates against the PLCopen TC6 v2.01 schema (the copy shipped with Beremiz), for every supported element kind. It has not yet been imported into a PLC editor, so drawing positions and compiler behaviour there are unconfirmed. To repeat the schema check, point `LADDER_XSD` at a copy of `tc6_xml_v201.xsd` and run `npm test` (needs `xmllint`).
- Comparison blocks continue the rung from `OUT` with the rung wired to `EN`, which relies on `OUT` being FALSE while `EN` is FALSE (true for OpenPLC's compiler).
- Simulation is not a safety validation. Emergency stops and guards belong in hardwired or safety-rated circuits, not in this logic.
