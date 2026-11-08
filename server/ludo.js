import crypto from 'node:crypto';

/**
 * Server-authoritative Ludo engine.
 *
 * Coordinate system: 15x15 grid, [row, col].
 * Every seat walks the same 52-cell ring (RING) and then turns into its own
 * 5-cell home column before reaching HOME (the centre triangle).
 *
 * Relative position `p` for a token:
 *   -1        -> in the yard
 *   0..50     -> ring cell  RING[(seat.start + p) % 52]
 *   51..55    -> home column cell (seat.home[p - 51])
 *   56 (HOME) -> finished
 *
 * All dice rolls and move validation happen here on the server. The client only
 * ever receives the already-validated state, so a tampered client cannot invent
 * rolls, extra steps or captures.
 */

export const BOARD_SIZE = 15;
export const YARD = -1;
export const HOME = 56;
export const RING_LENGTH = 52;
export const SAFE_POSITIONS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export const RING = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
  [0, 7],
  [0, 8],
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14],
  [8, 14],
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  [14, 7],
  [14, 6],
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0],
  [6, 0],
];

/** seat definitions: start ring index, home column cells, yard slots */
export const SEATS = {
  red: {
    key: 'red',
    label: 'Red',
    start: 0,
    hex: '#f43f5e',
    light: '#ffe4e6',
    home: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
    yard: [[1, 1], [1, 3], [3, 1], [3, 3]],
    base: { row: 0, col: 0 },
  },
  green: {
    key: 'green',
    label: 'Green',
    start: 13,
    hex: '#22c55e',
    light: '#dcfce7',
    home: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
    yard: [[1, 10], [1, 12], [3, 10], [3, 12]],
    base: { row: 0, col: 9 },
  },
  yellow: {
    key: 'yellow',
    label: 'Yellow',
    start: 26,
    hex: '#eab308',
    light: '#fef9c3',
    home: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
    yard: [[10, 10], [10, 12], [12, 10], [12, 12]],
    base: { row: 9, col: 9 },
  },
  blue: {
    key: 'blue',
    label: 'Blue',
    start: 39,
    hex: '#3b82f6',
    light: '#dbeafe',
    home: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
    yard: [[10, 1], [10, 3], [12, 1], [12, 3]],
    base: { row: 9, col: 0 },
  },
};

export const SEAT_ORDER = ['red', 'green', 'yellow', 'blue'];
/** 2 player matches use opposite corners so the race is fair */
export const TWO_PLAYER_SEATS = ['red', 'yellow'];

export function seatsForPlayerCount(playerCount) {
  return playerCount === 2 ? [...TWO_PLAYER_SEATS] : [...SEAT_ORDER];
}

export function ringIndexFor(seatKey, p) {
  const seat = SEATS[seatKey];
  return (seat.start + p) % RING_LENGTH;
}

/** Absolute ring index a token occupies, or null when in yard / home column */
export function absoluteRingIndex(seatKey, p) {
  if (p < 0 || p > 50) return null;
  return ringIndexFor(seatKey, p);
}

export function cellFor(seatKey, p, tokenIndex = 0) {
  const seat = SEATS[seatKey];
  if (p === YARD) return seat.yard[tokenIndex % seat.yard.length];
  if (p === HOME) return [7, 7];
  if (p <= 50) return RING[ringIndexFor(seatKey, p)];
  return seat.home[p - 51];
}

const defaultRng = () => crypto.randomInt(1, 7);

export function createGame({
  id,
  playerCount = 4,
  mode = 'classic',
  entryFee = 0,
  players = [],
  rng = defaultRng,
  now = Date.now(),
}) {
  const seatKeys = seatsForPlayerCount(playerCount);
  const seats = seatKeys.map((key, index) => {
    const p = players[index] || {};
    return {
      seat: key,
      color: SEATS[key].hex,
      userId: p.userId ?? null,
      username: p.username || SEATS[key].label,
      avatar: p.avatar || '🎲',
      isBot: Boolean(p.isBot),
      connected: true,
      tokens: [YARD, YARD, YARD, YARD],
      finished: false,
      rank: null,
      captures: 0,
      homes: 0,
    };
  });

  return {
    id,
    mode,
    playerCount,
    entryFee,
    pot: entryFee * playerCount,
    seats,
    turn: 0,
    dice: null,
    moves: [],
    rolled: false,
    consecutiveSixes: 0,
    status: 'active',
    winnerSeat: null,
    ranking: [],
    log: [],
    createdAt: now,
    updatedAt: now,
    turnStartedAt: now,
    moveCount: 0,
    rng,
  };
}

export function currentSeat(game) {
  return game.seats[game.turn];
}

function seatIsDone(seat) {
  return seat.tokens.every((t) => t === HOME);
}

/** All token indexes the current player may legally move with `dice`. */
export function legalMoves(game, dice = game.dice) {
  if (game.status !== 'active' || !dice) return [];
  const seat = currentSeat(game);
  if (seat.finished) return [];
  const moves = [];
  for (let i = 0; i < seat.tokens.length; i += 1) {
    const p = seat.tokens[i];
    if (p === HOME) continue;
    if (p === YARD && dice !== 6) continue;
    if (p >= 0 && p + dice > HOME) continue;
    moves.push(i);
  }
  return moves;
}

function ringOccupants(game, absoluteIndex, exceptSeat) {
  const found = [];
  for (const seat of game.seats) {
    if (seat.seat === exceptSeat) continue;
    for (let i = 0; i < seat.tokens.length; i += 1) {
      const p = seat.tokens[i];
      if (p < 0 || p > 50) continue;
      if (ringIndexFor(seat.seat, p) === absoluteIndex) {
        found.push({ seat: seat.seat, tokenIndex: i, p });
      }
    }
  }
  return found;
}

/** Dry-run a move so bots/UI hints can score it without mutating state. */
export function previewMove(game, tokenIndex) {
  const seat = currentSeat(game);
  const dice = game.dice;
  const p = seat.tokens[tokenIndex];
  if (p === undefined || dice === null) return null;
  const target = p === YARD ? 0 : p + dice;
  if (p !== YARD && target > HOME) return null;
  if (p === YARD && dice !== 6) return null;

  const abs = absoluteRingIndex(seat.seat, target);
  const captures =
    abs !== null && !SAFE_POSITIONS.has(abs) ? ringOccupants(game, abs, seat.seat) : [];
  return {
    tokenIndex,
    from: p,
    to: target,
    reachesHome: target === HOME,
    leavesYard: p === YARD,
    entersHomeColumn: target >= 51 && target < HOME,
    landsSafe: abs !== null && SAFE_POSITIONS.has(abs),
    captures: captures.map((c) => `${c.seat}:${c.tokenIndex}`),
    captureCount: captures.length,
  };
}

export function rollDice(game, rng = game.rng || defaultRng) {
  if (game.status !== 'active') return { ok: false, error: 'Match is not active' };
  if (game.rolled) return { ok: false, error: 'Dice already rolled' };
  const seat = currentSeat(game);
  if (seat.finished) return { ok: false, error: 'Seat already finished' };

  const dice = rng();
  game.dice = dice;
  game.rolled = true;
  game.updatedAt = Date.now();

  if (dice === 6) {
    game.consecutiveSixes += 1;
    if (game.consecutiveSixes >= 3) {
      // classic rule: three sixes in a row forfeits the turn
      game.moves = [];
      return { ok: true, dice, moves: [], forfeit: true, tripleSix: true };
    }
  } else {
    game.consecutiveSixes = 0;
  }

  game.moves = legalMoves(game, dice);
  return {
    ok: true,
    dice,
    moves: game.moves,
    forfeit: game.moves.length === 0,
  };
}

export function applyMove(game, tokenIndex) {
  if (game.status !== 'active') return { ok: false, error: 'Match is not active' };
  if (!game.rolled) return { ok: false, error: 'Roll the dice first' };
  if (!game.moves.includes(tokenIndex)) return { ok: false, error: 'Illegal move' };

  const seat = currentSeat(game);
  const from = seat.tokens[tokenIndex];
  const to = from === YARD ? 0 : from + game.dice;
  const events = [];

  seat.tokens[tokenIndex] = to;
  game.moveCount += 1;
  events.push({
    type: 'move',
    seat: seat.seat,
    tokenIndex,
    from,
    to,
    dice: game.dice,
  });

  let captured = 0;
  const abs = absoluteRingIndex(seat.seat, to);
  if (abs !== null && !SAFE_POSITIONS.has(abs)) {
    for (const other of game.seats) {
      if (other.seat === seat.seat) continue;
      for (let i = 0; i < other.tokens.length; i += 1) {
        const op = other.tokens[i];
        if (op < 0 || op > 50) continue;
        if (ringIndexFor(other.seat, op) !== abs) continue;
        other.tokens[i] = YARD;
        captured += 1;
        events.push({
          type: 'capture',
          seat: seat.seat,
          victimSeat: other.seat,
          victimTokenIndex: i,
          at: abs,
        });
      }
    }
  }
  if (captured) seat.captures += captured;

  if (to === HOME) {
    seat.homes = seat.tokens.filter((t) => t === HOME).length;
    events.push({ type: 'home', seat: seat.seat, tokenIndex, total: seat.homes });
  }

  let finished = false;
  if (seatIsDone(seat) && !seat.finished) {
    seat.finished = true;
    seat.rank = game.ranking.length + 1;
    game.ranking.push(seat.seat);
    events.push({ type: 'seatFinished', seat: seat.seat, rank: seat.rank });
    if (game.ranking.length === 1) {
      // first player to bring all four tokens home wins the match
      finished = true;
      game.status = 'finished';
      game.winnerSeat = seat.seat;
      events.push({ type: 'matchFinished', winnerSeat: seat.seat });
    }
  }

  game.updatedAt = Date.now();
  game.moves = [];
  game.rolled = false;

  const extraTurn = !finished && (game.dice === 6 || captured > 0 || to === HOME);
  if (!finished && !extraTurn) {
    game.consecutiveSixes = 0;
  }
  return { ok: true, events, extraTurn, finished };
}

/** Advance to the next seat that still has tokens to move. */
export function nextTurn(game) {
  game.dice = null;
  game.moves = [];
  game.rolled = false;
  game.consecutiveSixes = 0;
  game.turnStartedAt = Date.now();
  game.updatedAt = Date.now();
  if (game.status !== 'active') return game;
  const total = game.seats.length;
  for (let step = 1; step <= total; step += 1) {
    const idx = (game.turn + step) % total;
    if (!game.seats[idx].finished) {
      game.turn = idx;
      return game;
    }
  }
  return game;
}

export function passTurn(game) {
  if (game.status !== 'active') return game;
  game.dice = null;
  game.moves = [];
  game.rolled = false;
  game.consecutiveSixes = 0;
  return nextTurn(game);
}

/** Simple, deterministic bot: capture > finish > leave yard > safe > furthest. */
export function chooseBotMove(game) {
  const moves = game.moves.length ? game.moves : legalMoves(game);
  if (!moves.length) return null;
  let best = null;
  for (const tokenIndex of moves) {
    const preview = previewMove(game, tokenIndex);
    if (!preview) continue;
    let score = 0;
    score += preview.captureCount * 1000;
    if (preview.reachesHome) score += 600;
    if (preview.leavesYard) score += 220;
    if (preview.entersHomeColumn) score += 160;
    if (preview.landsSafe) score += 90;
    score += preview.to * 0.5;
    // avoid parking a token right in front of an opponent start
    if (best === null || score > best.score) best = { tokenIndex, score, preview };
  }
  return best ? best.tokenIndex : moves[0];
}

/** Client-safe view of the match state (no rng function, no internals). */
export function serializeGame(game, { turnMs = 0 } = {}) {
  return {
    id: game.id,
    mode: game.mode,
    playerCount: game.playerCount,
    entryFee: game.entryFee,
    pot: game.pot,
    status: game.status,
    turn: game.turn,
    dice: game.dice,
    moves: game.moves,
    rolled: game.rolled,
    winnerSeat: game.winnerSeat,
    ranking: game.ranking,
    moveCount: game.moveCount,
    turnDeadline: turnMs ? game.turnStartedAt + turnMs : null,
    seats: game.seats.map((s) => ({
      seat: s.seat,
      color: s.color,
      userId: s.userId,
      username: s.username,
      avatar: s.avatar,
      isBot: s.isBot,
      connected: s.connected,
      tokens: [...s.tokens],
      finished: s.finished,
      rank: s.rank,
      captures: s.captures,
      homes: s.homes,
    })),
  };
}
