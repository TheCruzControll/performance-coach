/**
 * Display strings for every dashboard and review service, in the owner's units through M1's
 * units: weights in kg or lb, distances in km or mi, paces per km or per mile. The services keep
 * canonical values (kg, metres, s/km); each display string comes with its canonical value, which
 * a screen puts in data-value so tests and the coach read the number, never the words.
 *
 * Decision (m6-plan open question 'Progress now shows numbers in the units set in your
 * profile'): UNITS_FROM is the profile, as M4's logging uses it, not the device's setting.
 */
import type { Metric } from '../../../domain/analytics/metrics';
import { formatCanonical, type Format } from '../../../domain/analytics/overview';
import type { AthleteProfile, ProfileDistanceUnit } from '../../../domain/profile/types';
import {
	cleanFloat,
	convertPace,
	convertWeight,
	formatDuration,
	fromMetres,
	type WeightUnit
} from '../../../domain/units';

export const UNITS_FROM = 'profile' as const;

export interface DisplayUnits {
	weight: WeightUnit;
	distance: ProfileDistanceUnit;
}

/** The units Progress shows: the profile's (UNITS_FROM). */
export const displayUnits = (
	profile: Pick<AthleteProfile, 'weightUnit' | 'distanceUnit'>
): DisplayUnits => ({ weight: profile.weightUnit, distance: profile.distanceUnit });

/** A display string and the canonical value it shows. */
export interface Shown {
	text: string;
	value: number;
}

const number = (value: number, decimals: number) =>
	(cleanFloat(value, decimals) + 0).toLocaleString('en-US', { maximumFractionDigits: decimals });

/** A weight in kg, shown in `unit` to 0.1: '220.5 lb'. */
export const weight = (kg: number, { weight: unit }: DisplayUnits): Shown => ({
	text: `${number(convertWeight(kg, 'kg', unit), 1)} ${unit}`,
	value: kg
});

/** A distance in metres, shown in km or mi to 0.1: '3.1 mi'. */
export const distance = (metres: number, { distance: unit }: DisplayUnits): Shown => ({
	text: `${number(fromMetres(metres, unit), 1)} ${unit}`,
	value: metres
});

/** A pace in s/km, shown per km or per mile: '8:03 /mi'. */
export const pace = (secondsPerKm: number, { distance: unit }: DisplayUnits): Shown => ({
	text: `${formatDuration(convertPace(secondsPerKm, 'km', unit))} /${unit}`,
	value: secondsPerKm
});

/**
 * overview.ts's Format in the owner's units: kg, metres and s/km converted (a pace's change in
 * whole seconds per km or mile), every other unit as formatCanonical words it.
 */
export function formatIn(units: DisplayUnits): Format {
	return (metric: Metric, value: number, as: 'value' | 'delta') => {
		switch (metric.unit) {
			case 'kg':
				return weight(value, units).text;
			case 'm':
				return distance(value, units).text;
			case 's/km':
				return as === 'value'
					? pace(value, units).text
					: `${number(convertPace(value, 'km', units.distance), 0)} s/${units.distance}`;
			default:
				return formatCanonical(metric, value, as);
		}
	};
}
