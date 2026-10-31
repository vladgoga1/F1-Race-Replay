// Pixel-art F1 car seen from above. One small picture (22 x 11 pixels) is painted once per
// team colour and then reused: the map only has to stamp it on the canvas, rotated.
//
// The picture is written as text: one character = one pixel. The car looks to the RIGHT, so
// "angle 0" means "driving towards +x" and rotating by the heading of the car is all we need.
//   K = tyre   B = body (team colour)   D = darker body (wings, floor)   C = cockpit / halo
//   S = stripe on the engine cover   H = helmet   L = light tip of the nose   . = empty
const ART = [
  "...KKKKK..............",
  "DD.KKKKK.....KKKK..DD.",
  "DD.KKKKK.....KKKK..DD.",
  "DD.DDDD.BBBBBBDDD..DD.",
  "DDBBBBBBBCCCBBBBB..DD.",
  "DDBSSSSSBCHCBBBBBBBDDL",
  "DDBBBBBBBCCCBBBBB..DD.",
  "DD.DDDD.BBBBBBDDD..DD.",
  "DD.KKKKK.....KKKK..DD.",
  "DD.KKKKK.....KKKK..DD.",
  "...KKKKK..............",
];
export const SPRITE_WIDTH = ART[0].length;    // 22 (the length of the car)
export const SPRITE_HEIGHT = ART.length;      // 11 (its width)

// "#rrggbb" -> [r, g, b]
function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Mixes a colour with another one: amount 0 = the colour, 1 = the other. Used to get a darker
// and a lighter version of the team colour from the single colour we have for every team.
function mix(rgb, other, amount) {
  return "rgb(" + rgb.map((v, i) => Math.round(v + (other[i] - v) * amount)).join(",") + ")";
}

const cache = new Map();

/*
 * Returns a small off-screen canvas with the car painted in `color`. A canvas can be used as an
 * image in drawImage(), and we keep it in a Map so every colour is painted only once.
 * `variant` tells the two cars of a team apart (they have the same colour): the engine cover
 * stripe is white for variant 0 and black for variant 1.
 */
export function carSprite(color, variant = 0) {
  const key = `${color}|${variant}`;
  if (cache.has(key)) return cache.get(key);

  const rgb = parseHex(color);
  const palette = {
    K: "#63636f",                       // real tyres are black, but black vanishes on the dark map
    B: color,
    D: mix(rgb, [0, 0, 0], 0.45),
    C: "#0b0b0e",
    S: variant === 0 ? "#ffffff" : "#0b0b0e",
    H: "#f2f2f2",
    L: mix(rgb, [255, 255, 255], 0.55),
  };

  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_WIDTH;
  canvas.height = SPRITE_HEIGHT;
  const ctx = canvas.getContext("2d");
  ART.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === ".") continue;
      ctx.fillStyle = palette[row[x]];
      ctx.fillRect(x, y, 1, 1);
    }
  });
  cache.set(key, canvas);
  return canvas;
}
