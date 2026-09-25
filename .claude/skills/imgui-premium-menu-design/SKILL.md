---
name: imgui-premium-menu-design
description: >
  Use this skill whenever creating, redesigning, or polishing a Dear ImGui menu.
  The goal is to produce a bespoke, modern application-style interface like the
  provided references rather than a recognisable default Dear ImGui menu.
---

# ImGui Premium Menu Design

## Purpose

When generating Dear ImGui interfaces, do **not** fall back to the normal ImGui
visual language. The output should feel like a custom-designed desktop product
or polished game configuration panel built in Figma and then implemented in
ImGui.

The reference style is:

- dark, low-contrast, premium
- compact but not cramped
- clean grid-based alignment
- heavily customised controls
- subtle borders and layered surfaces
- one strong accent colour
- clear visual hierarchy
- custom navigation
- minimal visual noise
- smooth, restrained interaction animation

The user should never look at the final interface and immediately think
"default ImGui with different colours".

---

# Hard Rules

These rules are mandatory unless the user explicitly asks for a different style.

## 1. Never expose the default ImGui look

Do not visually rely on:

- default `ImGui::Button`
- default `ImGui::Checkbox`
- default `ImGui::SliderFloat`
- default `ImGui::Combo`
- default tab bars
- default tree nodes
- default collapsing headers
- default window title bars
- default menu bars
- default framed child windows
- default separators everywhere
- obvious ImGui square spacing / stock padding

Using ImGui for layout, clipping, IDs, input handling, and state is fine.

The visible layer should be custom.

Prefer:

- `ImDrawList`
- `InvisibleButton`
- manually drawn tracks, knobs, fills, borders, cards and tabs
- custom text placement
- custom hover / active state rendering
- custom popup shells
- custom navigation rows

---

# Visual Direction

## 2. Overall shell

The main application surface should normally use:

- near-black base background
- slightly lighter content panels
- subtle elevation through tonal contrast rather than heavy shadows
- rounded outer corners
- no bright outer border
- generous but controlled padding
- a strong silhouette

Suggested starting palette:

```cpp
bg_root       = #0D0E13
bg_sidebar    = #101117
bg_panel      = #14151C
bg_panel_alt  = #181923
bg_control    = #1C1D27
border_subtle = #242630

text_primary  = #F1F2F6
text_muted    = #858899
text_dim      = #5E6170

accent        = #6C60FF
accent_hover  = #7A6FFF
accent_soft   = accent at 12-22% alpha
```

These are starting values, not a requirement to hardcode those exact colours.

If the user provides a reference image with a different accent colour, preserve
the same design system and change the accent.

---

# Layout System

## 3. Use a deliberate grid

Build the UI around a consistent spacing system.

Recommended scale:

```text
4   micro spacing
8   tight spacing
12  control spacing
16  standard spacing
20  section spacing
24  card padding
32  major separation
```

Do not scatter arbitrary pixel values throughout the code.

Create a design token structure such as:

```cpp
struct UiMetrics {
    float radius_sm;
    float radius_md;
    float radius_lg;

    float gap_xs;
    float gap_sm;
    float gap_md;
    float gap_lg;

    float control_h;
    float nav_h;
    float header_h;

    float sidebar_w;
    float content_pad;
};
```

Scale the system using a DPI/UI scale value.

---

## 4. Main composition

The preferred composition is one of these:

### A. Sidebar + workspace

Like the first and third references:

```text
┌───────────────────────────────────────────────┐
│ sidebar │ top bar / config selector           │
│         ├─────────────────────────────────────┤
│ nav     │ section      │ section              │
│ nav     │ controls     │ controls             │
│ nav     │              │                      │
└───────────────────────────────────────────────┘
```

### B. Top navigation + two-column workspace

Like the second reference:

```text
┌───────────────────────────────────────────────┐
│ brand        Combat   Visuals   Exploits Misc │
├───────────────────────────────────────────────┤
│ breadcrumb / local nav                        │
├──────────────────────┬────────────────────────┤
│ left card            │ right card             │
│ controls             │ controls               │
└──────────────────────┴────────────────────────┘
```

Do not make every menu the same. Choose the structure that best suits the
content, but keep the same visual grammar.

---

# Navigation

## 5. Sidebar rules

For sidebar navigation:

- use icons + labels when there is enough width
- icon-only rails are acceptable for compact layouts
- active items should use a subtle tinted background or accent marker
- inactive items should be muted
- avoid thick boxes around every nav item
- use 32-40 px item height
- keep icon geometry visually consistent
- avoid emoji as interface icons

A good active state is:

- slightly brighter text
- accent icon
- subtle accent-tinted background
- optional 2 px accent edge or dot

Do not use a giant saturated rectangle.

---

## 6. Top navigation rules

When using top tabs:

- keep them horizontally aligned
- use text and optional small chevron
- active tab should be visually connected to the content
- prefer tonal highlight, thin underline, or subtle background
- do not use stock `BeginTabBar`

---

# Cards and Sections

## 7. Card styling

Cards should feel embedded into the shell.

Typical card:

```text
background: +3% to +7% brighter than parent
border: 1 px low-contrast
radius: 6-10 px
padding: 10-16 px
```

Avoid:

- large drop shadows
- glowing borders
- excessive gradients
- heavy outlines
- every section being a floating card

Use hierarchy sparingly.

---

## 8. Section headers

Section headers should be quiet.

Use:

- 11-13 px muted uppercase or small title
- 14-16 px normal title for more important sections
- 8-12 px spacing beneath header
- optional chevron aligned to the far right

Do not use oversized headings.

---

# Typography

## 9. Type hierarchy

Use a modern sans font such as:

- Inter
- Geist
- SF Pro style equivalent
- Roboto
- Segoe UI
- Manrope

Recommended hierarchy:

```text
Brand / page title      15-17 px semibold
Primary section         13-15 px medium
Control label           12-14 px regular/medium
Secondary label         11-13 px
Metadata / helper text  10-12 px muted
```

Rules:

- avoid bold text everywhere
- avoid pure white for every label
- reserve highest contrast for active/important text
- align baselines carefully
- keep label widths consistent within a section

---

# Controls

## 10. Toggle switches

Do not use stock checkboxes for boolean settings unless the reference requires
checkboxes.

Preferred toggle:

```text
width: 28-34 px
height: 14-18 px
pill radius: full
knob: circular
off track: dark muted
on track: accent tint
on knob: accent or near-white
```

Add:

- hover interpolation
- knob slide animation
- subtle track colour interpolation

Animation target: approximately 120-180 ms.

---

## 11. Sliders

Sliders should resemble the references:

- thin horizontal track
- track height around 3-5 px
- circular handle
- active fill uses accent
- inactive section uses darker panel colour
- label on left
- current value aligned right or just before the track
- no large stock slider grab

Example:

```text
Field of view                 90°
────────────────────●────────────
```

For compact rows:

```text
Field of view      90°   ━━━━━●━━━━━━
```

The interaction hitbox can be taller than the visible track.

---

## 12. Combo boxes / dropdowns

Do not expose default combo styling.

Preferred combo:

- 26-32 px tall
- dark recessed fill
- 4-6 px radius
- thin or invisible border
- text left aligned
- small chevron right aligned
- entire row clickable
- popup uses the same surface language as cards

Popup:

- no stock ImGui blue selection
- custom row hover
- 6-8 px radius
- 4-8 px internal padding
- selected item may use accent tint

---

## 13. Buttons

Buttons should be rare.

When needed:

### Primary button
- accent fill
- white or near-white label
- 5-8 px radius
- subtle hover brightening

### Secondary button
- dark fill
- low-contrast border
- muted label that brightens on hover

Avoid giant pill buttons unless intentionally requested.

---

## 14. Checkbox-style controls

If a literal checkbox is appropriate:

- draw a 12-15 px square manually
- 2-4 px radius
- dark inactive fill
- accent active fill
- custom tick
- align perfectly with label baseline

Do not use the stock ImGui checkbox glyph.

---

## 15. Colour controls

For colour options:

- use a small rounded square swatch
- 12-16 px
- position on the far right of the row
- clicking the swatch opens a custom-styled picker popup
- do not make the full row into a giant colour editor

---

## 16. Keybind controls

Preferred keybind presentation:

```text
Aim Key                  Mouse 4
```

or

```text
[      Keybind      ]
```

Use a compact dark field or button.

When listening for input:

- change the text to `Press a key...`
- subtly change border or accent
- do not open a random stock popup

---

# Row Construction

## 17. Settings rows

Most settings should be expressed as structured rows.

Example:

```text
Label                            value/control
```

A standard row should have:

- 32-42 px height
- vertically centred content
- optional very subtle bottom divider
- consistent label x-position
- consistent right-edge alignment
- enough hit area for interaction

Avoid wrapping labels unless necessary.

---

# Interaction and Animation

## 18. Motion language

The references are visually calm. Animation must be restrained.

Use animation for:

- tab transitions
- toggle knob movement
- hover fades
- active accent fades
- dropdown expansion
- popup appearance
- slider value smoothing where useful

Recommended timing:

```text
hover:         80-120 ms
toggle:       120-180 ms
tab:          140-220 ms
popup:        120-180 ms
page fade:    160-220 ms
```

Use ease-out interpolation.

Avoid:

- bounce
- spring overshoot
- exaggerated scaling
- constant glow pulsing
- rainbow effects

unless requested.

---

# Custom Drawing Standard

## 19. Prefer draw-list composition

When visual polish matters, use:

```cpp
ImDrawList* dl = ImGui::GetWindowDrawList();
```

and compose controls from:

- `AddRectFilled`
- `AddRect`
- `AddCircleFilled`
- `AddLine`
- `AddText`
- `AddImage`
- path API for custom shapes

Use `InvisibleButton` for input capture.

A custom control should usually:

1. reserve its rectangle
2. create a stable ID
3. run `InvisibleButton`
4. detect hover / held / click
5. update value
6. animate state
7. draw the result manually

---

# Component Architecture

## 20. Build reusable widgets

Do not implement every control inline.

Create a small custom UI layer such as:

```cpp
namespace ui {
    bool Toggle(const char* label, bool* value);
    bool Slider(const char* label, float* value, float min, float max,
                const char* format);
    bool Combo(const char* label, int* value,
               const char* const items[], int count);
    bool Keybind(const char* label, Keybind* bind);
    bool ColorField(const char* label, ImVec4* colour);

    bool NavItem(Icon icon, const char* label, bool selected);
    bool TopTab(const char* label, bool selected);

    void BeginCard(const char* id, const ImVec2& size);
    void EndCard();

    void SectionLabel(const char* text);
    void SettingRow(...);
}
```

The goal is to make the menu design system reusable across pages.

---

# Icons

## 21. Icon rules

Prefer:

- a proper icon font
- SVG converted to texture or draw-list paths
- simple custom geometry

Good icon families:

- Lucide
- Phosphor
- Font Awesome
- Remix
- custom outlined glyph set

Rules:

- icons should share stroke/weight
- muted when inactive
- accent or brighter when active
- never mix multiple unrelated icon styles

---

# Window Behaviour

## 22. Main menu window

The main menu should normally:

- have no stock title bar
- use a custom header if needed
- use custom drag behaviour or an invisible drag region
- optionally use custom resize handling
- have rounded outer corners
- respect DPI scaling
- avoid unnecessary scrollbars

If scrolling is necessary:

- make the scrollbar narrow
- recolour it to match the UI
- avoid stock ImGui scrollbar appearance

---

# Density

## 23. Keep the interface compact

The references use information-dense layouts.

Target:

- several visible controls per card
- short row heights
- narrow title hierarchy
- limited empty space
- enough breathing room to maintain clarity

Do not make the interface look like a mobile app blown up for desktop.

---

# Colour Discipline

## 24. Use one primary accent

The menu should normally have:

- one primary accent colour
- neutral dark surfaces
- neutral text scale
- optional semantic colours for warning / success

Do not use unrelated accent colours for different controls.

If one page uses violet, keep toggles, sliders, selected icons and active states in
that same violet family.

---

# Borders and Contrast

## 25. Keep contrast controlled

Do not outline everything.

Use border hierarchy:

```text
outer shell:       none or extremely subtle
card border:       subtle
control border:    subtle or none
active element:    accent tint or brighter border
popup border:      slightly more visible
```

The UI should be readable because of spacing, grouping, and tonal separation,
not because every object is boxed.

---

# Responsive Behaviour

## 26. Adapt gracefully

Do not hardcode the design to one screenshot resolution.

The menu should:

- support DPI scaling
- allow configurable window size
- preserve minimum card widths
- switch two-column content to stacked content when too narrow
- keep sidebar/nav proportions consistent
- avoid text clipping

Prefer calculations based on available region:

```cpp
float available = ImGui::GetContentRegionAvail().x;
float gap = metrics.gap_md;
float card_w = (available - gap) * 0.5f;
```

---

# Reference Image Matching

## 27. When a reference image is supplied

If the user provides an interface screenshot:

1. inspect its overall structure
2. identify navigation model
3. estimate spacing rhythm
4. identify surface hierarchy
5. identify accent colour
6. identify control shapes
7. identify font hierarchy
8. identify card proportions
9. identify border/radius language
10. reproduce the visual system rather than copying only colours

Never respond to a reference by merely changing:

```cpp
ImGuiCol_WindowBg
ImGuiCol_Button
ImGuiCol_CheckMark
```

That is insufficient.

---

# Anti-Patterns

## 28. Reject these patterns

Avoid designs that look like:

### Default ImGui recolour

```text
[ Checkbox ] Setting
[=====|----] Slider
[ Combo v ]
[ Button ]
```

with nothing else changed.

### Old cheat-menu styling

Avoid:

- neon outlines everywhere
- giant glowing titles
- rainbow gradients
- extremely rounded pill everything
- overly bright purple-on-black
- excessive drop shadows
- 2018-era tab strips
- tiny unreadable fonts
- giant sidebars packed with text

### Generic web-dashboard styling

Avoid blindly recreating:

- huge 24-32 px cards
- massive headings
- empty whitespace
- floating SaaS dashboard tiles

The references are desktop-tool dense, not generic website dashboards.

---

# Quality Bar

## 29. Before considering a menu finished

Verify all of the following:

- [ ] It does not look like default ImGui.
- [ ] All visible controls share the same design language.
- [ ] Spacing follows a clear rhythm.
- [ ] Active navigation is obvious but not loud.
- [ ] Typography has at least 3 contrast levels.
- [ ] Sliders are custom drawn.
- [ ] Toggles are custom drawn.
- [ ] Dropdowns are custom styled.
- [ ] Cards use subtle rather than heavy borders.
- [ ] One accent colour is used consistently.
- [ ] Controls align to a common grid.
- [ ] Hover states exist.
- [ ] Active states exist.
- [ ] Motion is subtle.
- [ ] DPI scaling is considered.
- [ ] No accidental stock ImGui widgets are visible.
- [ ] The menu looks intentional at first glance.

---

# Implementation Preference

When Claude is asked to create a menu, prefer producing:

1. a small reusable design-token/theme layer
2. custom control helpers
3. the actual page/menu composition
4. minimal dependence on stock widget rendering
5. code that can be dropped into an existing Dear ImGui project

Do not spend most of the implementation on generic engine architecture unless
requested.

The visual result is the priority.

---

# Default Creative Direction

If the user gives no specific visual direction, default to this:

- deep charcoal/black shell
- slightly lighter card surfaces
- violet accent
- 8 px card radius
- 10-12 px control radius where appropriate
- compact 34-38 px setting rows
- 13 px body text
- 11-12 px muted labels
- sidebar or top-tab navigation
- custom toggles
- thin sliders
- subtle dividers
- Lucide/Phosphor-style line icons
- 150 ms ease-out interactions
- no visible stock ImGui styling

The final result should feel closer to the supplied LineFlow / Givenchy /
minimal violet menu references than to the Dear ImGui demo window.
