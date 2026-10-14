# Apaki's style: what it takes from Myrlin Glass

Written 2026-10-13 for Arthur's ask: "myrlin glass ui/ux is much clearer, we want to borrow from it as much as possible with our theming/colors / the organization, the style, the layout". Glass's widget (`glass-lite/widget/ui`) was the reference; Apaki keeps its own colours, fonts and pearl ground and takes Glass's manner.

## The rules

1. **Hierarchy by weight and ink, not by boxes.** One strong line (a name, a title), a quieter second line, a faint third. The inks are `ink`, `soft` and `faint`. Glass reads clearly because nothing competes with the one thing in bold.
2. **Numbers in mono, with tabular figures.** Times, counts, percentages, sizes, ids. They line up and they read as data.
3. **Rows: a mark, the name, a value at the right.** A leading glyph or mini ring, the name, a right-aligned mono value (a time, a count). Even heights. The session list, the Glass card, menus and the side panel's entries all follow it.
4. **Selection and hover are soft fills.** Three raise levels (the `g-raise` tokens): hover is the first, selected the second, pressed the third. No border appears and no shadow lifts when something is chosen. Tabs, menu rows, chips, segmented switches and the side panel's tabs all select this way.
5. **Hairlines only between groups.** Sections of the sidebar, a card's head and body, a toolbar and what it controls. Not around every item, and never a stripe down one side.
6. **Colour only for meaning.** The providers (Claude clay `#d97757`, Codex green `#10a37f`), severity amber from 75% and red from 90% (Glass's steps), waiting for you in amber everywhere, finished in green, periwinkle for focus and the one primary action. Status is a ring, a glyph or a word; there is no status pill and no dot.
7. **Rings for usage.** The Glass card in the sidebar draws each provider's live account as Glass does: one ring with the share used large in its centre, the outer ring the short window (Session, 5-hour), a thinner inner ring the weekly one. The context meter in the composer is a mini ring. Rings fill with what is used, in the provider's colour, then amber, then red. Every window and the exact reset times stay in the panel a click opens ("show additional details when the user clicks in").
8. **Quiet small caps.** Labels and section heads in caps are 700 weight, 108% wide, .075em apart. They were 900 and 125%, which shouted over the content they label.
9. **Generous but tight.** 28 px controls in headers and toolbars, 8 px radii on controls, 12 to 14 px on cards and sheets, about 14 px of inset.
10. **Few live blurs.** Popovers, cards, bars and toolbars are opaque fills. A live backdrop blur on every pane header and card re-blurred on each step of the pearl, and a see-through fill without a blur shows the text under it as a ghost. The composer keeps its frost while it is the only one in the tab; a split's composers are opaque.
11. **Motion 150 to 200 ms**, transforms, opacity and ring arcs only, none under reduced motion. No animated shadows.

## What stays Apaki's own

- The colours: periwinkle marks and primary actions, peach light, the pearl ground and halftone, both themes.
- Archivo: the wordmark, pane titles, sheet headings and the empty conversation's title keep the heavy wide face. Spline Sans Mono for data.
- Primary buttons keep a gradient, within the brand's own indigo (`#4653BA` to `#2F3A8E`, darker in dark mode). It used to turn to violet; that is gone. Secondary buttons are flat with a hairline.

## Where it lives

- `apaki/ui/app.css`, the section "Glass style (2026-10-13)" at the end of the file: its tokens (`g-raise-1` to `3`, `g-track`, the provider and severity colours, `g-surface`) and every rule. Earlier rules are kept as they were and this section wins by coming last.
- `apaki/ui/usage-rings.js`: `heroWindows`, `worstWindow`, `sevOf`, `heroRingHtml`, `heroFor`.
- `apaki/ui/glasscard.js`: `heroRowHtml`, the card's row.
- Tests: `test/apaki-usage-rings.test.js` and `test/apaki-glasscard.test.js`.

## Checking a change

Open the demo harness (`apaki/demo/README.md`): `desktop.html?ws=steer`, `side-panel`, `viewers`, `codex`, `glass-swap` (click the Glass card), and `phone.html?ws=phone`, in light and dark, at 1440x900, 1280x800 and 390x844.
