# Node color reference

Source: `~/Downloads/ScreenRecording_09-06-2026 23-16-11_1.MP4`,
1180 × 2556, 60 fps. Samples are decoded RGB medians from small patches, avoiding
text and antialiased edges. These are observations of the recording, not guessed
multipliers of a single faction color.

## Idle nodes (5.0 seconds)

| Faction | Center (video pixels) | Upper/middle body | Rim | Lower highlight |
|---|---|---|---|---|
| Red | 110, 786 | `#a93343` | `#ff4a62` | `#f895a3` |
| Green | 878, 1552 | `#006b43` | `#0ed887` | `#69c5a2` |
| Gold | 494, 786 | `#967600` | `#e2b200` | `#e9ce69` |
| Blue | 302, 978 | `#2a5fa0` | `#3b90f1` | `#8cbbef` |
| Purple | 494, 1168 | `#582988` | `#ac64f8` | `#af87d9` |

Nodes have approximately a 64-pixel radius in the video. The body stays mostly
flat across the upper half. The pale lower highlight is localized, not a gradient
that darkens the entire top. Purple has slightly more variation in the upper fill.
Idle numerals are white. The colored rim is approximately 0.13 node radii thick.

## Combat and reinforcement

Attacker samples: green at 10.8s (878,1552), gold at 20s (110,1744), blue at 26s
(110,978), purple at 36s (302,978), red at 54s (686,786).

| Faction | Attacker middle fill | Number ink |
|---|---|---|
| Red | `#ffa9b6` | `#be192b` |
| Green | `#a6efdf` | `#00a060` |
| Gold | `#ffeeab` | `#a88600` |
| Blue | `#a1cbf8` | `#105ab5` |
| Purple | `#d9b6fb` | `#702dba` |

Attackers have a pale top and middle that graduate toward a more saturated bottom.
Defenders remain more saturated through the middle and have highlights at both
ends: blue defender middle `#6aacF6`, red defender middle `#ff7689`. Their number
ink and fill retain their own faction, while their **outer halo uses the attacker’s
color**. Both have a thin white outside rim, much thinner than the idle colored rim.
Reinforcement (green at 16.7s) uses the saturated treatment with its own glow color.

The active halo is much stronger than the idle one. Along the top of the red node,
the video at radii 1.22 / 1.34 / 1.47 gives idle RGB (52,34,36) / (25,28,27) /
(9,25,22), versus attacking RGB (202,38,57) / (148,36,50) / (72,31,36).
The renderer approximates this falloff with cached gradients in CSS coordinates,
so the glow retains its proportions on different pixel densities.

## Verification and user preferences

Compared actual rendered sprites beside cropped video nodes at the same radius.
Flat body patches match the sampled colors; lower highlight and battle gradients
are approximations between sampled points, not a claim of pixel-identical assets.
The implementation lives in `public/board.js` (`NODE_PALETTE` and `_skin`).

Preserve the user's subsequent corrections: **normal-width numerals, no scaling
animations, and arrows traveling along the attack line**. Only brightness pulses.
The later glow preference supersedes the sampled halo strength: idle glow now
fades out at 1.3 node radii, combat at 1.42, with lower opacity in both states.
`node solver/board_gate.mjs` checks fixed bounds, the battle clock, arrow geometry,
role-specific skins, faction-specific inks, defender glow ownership, and replay.
