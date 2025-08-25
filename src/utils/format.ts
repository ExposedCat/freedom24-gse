export function formatTicker(ticker: string): string {
	return ticker.startsWith("+")
		? ticker.split(".")[0]
		: ticker.replaceAll(".US", "");
}

export function formatPrice(value: number): string {
	const absoluteValue = Math.abs(value);
	return absoluteValue >= 1000
		? `$${Math.round(absoluteValue).toLocaleString()}`
		: `$${absoluteValue.toFixed(2)}`;
}

export function formatMoneyChange(value: number): string {
	const sign = value > 0 ? "+" : value < 0 ? "-" : "";
	return `${sign}${formatPrice(value)}`;
}

export function formatPercentageChange(value: number): string {
	const sign = value > 0 ? "+" : value < 0 ? "-" : "";
	const absoluteValue = Math.abs(value);
	return `${sign}${absoluteValue.toFixed(1)}%`;
}

type TimeUnit = {
	label: string;
	milliseconds: number;
};

export function formatTimeLeft(start: Date, end: Date): string {
	let remainingMilliseconds = end.getTime() - start.getTime();
	if (remainingMilliseconds <= 0) return "now";
	const units: TimeUnit[] = [
		{ label: "y", milliseconds: 1000 * 60 * 60 * 24 * 365 },
		{ label: "m", milliseconds: 1000 * 60 * 60 * 24 * 30 },
		{ label: "d", milliseconds: 1000 * 60 * 60 * 24 },
		{ label: "h", milliseconds: 1000 * 60 * 60 },
		{ label: "m", milliseconds: 1000 * 60 },
	];
	const parts: string[] = [];
	let usedUnits = 0;
	for (const unit of units) {
		if (usedUnits >= 2) break;
		const value = Math.floor(remainingMilliseconds / unit.milliseconds);
		if (value > 0) {
			parts.push(`${value}${unit.label}`);
			remainingMilliseconds -= value * unit.milliseconds;
			usedUnits++;
		}
	}
	return parts.length > 0 ? parts.join(" ") : "now";
}
