import { describe, it, expect } from 'vitest';
import {
  canChooseKin,
  choiceFromStoredIds,
  chosenKin,
  kinIdsToSend,
  noKinChosen,
  rosterKinLabel,
  toggleKinChoice,
  type KinRosterState,
} from './kinChoice';
import type { RosterKin } from '../api/kinRoster';

const BISCUIT: RosterKin = { id: 'k1', name: 'Biscuit', adminId: 'flat1' };
const GRAVY: RosterKin = { id: 'k2', name: 'Gravy', adminId: null };
const PEPPER: RosterKin = { id: 'k3', name: null, adminId: null };
const KIN = [BISCUIT, GRAVY, PEPPER];

const off: KinRosterState = { status: 'ready', kin: KIN, chooseKin: false };
const on: KinRosterState = { status: 'ready', kin: KIN, chooseKin: true };

describe('canChooseKin', () => {
  it('is true only when the server says so and there is a Kin to choose', () => {
    expect(canChooseKin(on)).toBe(true);
    expect(canChooseKin(off)).toBe(false);
    expect(canChooseKin({ status: 'ready', kin: [], chooseKin: true })).toBe(false);
  });

  it('is false while the answer is unknown, so no picker appears on a guess', () => {
    expect(canChooseKin({ status: 'idle' })).toBe(false);
    expect(canChooseKin({ status: 'loading' })).toBe(false);
    expect(canChooseKin({ status: 'error' })).toBe(false);
  });
});

describe('toggleKinChoice', () => {
  it('unticks one Kin out of "every Kin"', () => {
    expect(toggleKinChoice(null, 'k2', KIN)).toEqual(['k1', 'k3']);
  });

  it('keeps the roster order whatever order the ticks were made in', () => {
    expect(toggleKinChoice(['k3'], 'k1', KIN)).toEqual(['k1', 'k3']);
  });

  it('goes back to "every Kin" when the last unticked Kin is ticked', () => {
    expect(toggleKinChoice(['k1', 'k3'], 'k2', KIN)).toBeNull();
  });

  it('can untick the last Kin, leaving none, which the form then refuses', () => {
    expect(toggleKinChoice(['k2'], 'k2', KIN)).toEqual([]);
  });

  it('drops a chosen id that is no longer on the roster', () => {
    expect(toggleKinChoice(['gone', 'k1'], 'k2', KIN)).toEqual(['k1', 'k2']);
  });
});

describe('chosenKin', () => {
  it('is the whole roster for "every Kin"', () => {
    expect(chosenKin(null, KIN)).toEqual(KIN);
  });

  it('is the chosen Kin that are on the roster', () => {
    expect(chosenKin(['k2', 'gone'], KIN)).toEqual([GRAVY]);
  });
});

describe('kinIdsToSend', () => {
  it('sends nothing for "every Kin": the server stores the whole roster', () => {
    expect(kinIdsToSend(null, on)).toEqual([]);
  });

  it('sends the chosen ids while choosing is on', () => {
    expect(kinIdsToSend(['k2'], on)).toEqual(['k2']);
  });

  it('sends nothing while choosing is off, even if a choice is still held', () => {
    expect(kinIdsToSend(['k2'], off)).toEqual([]);
  });

  it('sends nothing when the Kin could not be loaded', () => {
    expect(kinIdsToSend(['k2'], { status: 'error' })).toEqual([]);
    expect(kinIdsToSend(['k2'], { status: 'loading' })).toEqual([]);
  });
});

describe('noKinChosen', () => {
  it('is true only when Kin can be chosen and none is', () => {
    expect(noKinChosen([], on)).toBe(true);
    expect(noKinChosen(['gone'], on)).toBe(true);
    expect(noKinChosen(['k1'], on)).toBe(false);
    expect(noKinChosen(null, on)).toBe(false);
  });

  it('never blocks a form while choosing is off or unknown', () => {
    expect(noKinChosen([], off)).toBe(false);
    expect(noKinChosen([], { status: 'loading' })).toBe(false);
    expect(noKinChosen([], { status: 'error' })).toBe(false);
  });
});

describe('choiceFromStoredIds', () => {
  it('ticks a Kin stored under its own id', () => {
    expect(choiceFromStoredIds(['k2'], KIN)).toEqual(['k2']);
  });

  it('ticks a Kin an older visit stored under its admin record', () => {
    expect(choiceFromStoredIds(['flat1', 'k2'], KIN)).toEqual(['k1', 'k2']);
  });

  it('ticks nothing for ids the roster does not know', () => {
    expect(choiceFromStoredIds(['gone'], KIN)).toEqual([]);
  });
});

describe('rosterKinLabel', () => {
  it('never shows a blank or an id for a Kin with no name on file', () => {
    expect(rosterKinLabel(PEPPER)).toBe('Unnamed Kin');
    expect(rosterKinLabel({ name: '   ' })).toBe('Unnamed Kin');
    expect(rosterKinLabel(BISCUIT)).toBe('Biscuit');
  });
});
