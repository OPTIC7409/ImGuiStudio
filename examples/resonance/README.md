# Resonance

A settings window built end to end by the ImGui Menu Designer agent (Claude Code
with the `imgui-premium-menu-design` skill always loaded, driving ImGui Studio).
Nobody edited the code by hand. The run took 84 turns, 9 builds and about 12
minutes. Along the way the agent fixed two of its own compile errors, a colour
picker that rendered wrong, and a Dear ImGui assert it caught in the runtime log.

The brief it was given:

> Design the settings window for 'Resonance', a desktop audio production app. Sidebar
> navigation with icons: General, Audio, MIDI, Appearance, Shortcuts. Top bar with a
> preset/config selector. Implement at least the Audio page fully (output device
> dropdown, sample rate, buffer size slider, toggles for exclusive mode and low-latency
> monitoring, a colour field, a keybind) plus a lighter General page. Default creative
> direction from the skill.

Open it from the repository root:

```sh
npm run resonance        # -> http://localhost:7421
```

Layout: `theme/` (tokens, fonts, style), `widgets/` (the `ui::` control layer and
icons), `src/main.cpp` (the window and its five pages).
