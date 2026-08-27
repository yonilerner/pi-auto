/** Serializes best-effort digest writes for one extension session. */
export class DigestCoordinator {
	private pending: Promise<void> = Promise.resolve();

	schedule(update: () => Promise<unknown>): void {
		this.pending = this.pending
			.catch(() => undefined)
			.then(async () => {
				await update();
			});
	}

	async drain(): Promise<void> {
		await this.pending.catch(() => undefined);
	}
}
