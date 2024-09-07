import type { TestItem, TestItemCollection } from 'vscode';
import { TestController } from './testing';
import { GoTestItem, RootItem, TestCase } from './item';
import { TestItemProvider } from './itemProvider';

const debugResolve = false;

/**
 * Adapts between VSCode's TestController.resolveHandler and TestItemProvider.
 *
 * TestItemProvider could directly implement resolveHandler, but then the
 * provider would need to handle two separate trees of items or it would need to
 * use {@link TestItem} instead of {@link GoTestItem}. Past experience shows
 * that leads to difficult to maintain structures and code. This adapter allows
 * the provider to be implemented in a way that is natural given the nature of
 * Go and gopls, with the adapter handling the translation to the VSCode API.
 *
 * Originally this adapter was agnostic of the provider item type and required a
 * generic TestItemProvider implementation similar to a TreeDataProvider.
 * However, maintaining that was impractical and lead to unnecessarily complex
 * (and hard to maintain) code.
 */
export class TestItemProviderAdapter {
	readonly #ctrl: TestController;
	readonly #provider: TestItemProvider;
	readonly #items = new Map<string, GoTestItem>();

	constructor(ctrl: TestController, provider: TestItemProvider) {
		this.#ctrl = ctrl;
		this.#provider = provider;
	}
	getGoItem(id: string) {
		return this.#items.get(id);
	}

	get roots() {
		const { items } = this.#ctrl;
		function* it() {
			for (const [, item] of items) {
				yield item;
			}
		}
		return it();
	}

	async resolve(item?: TestItem) {
		if (item) item.busy = true;

		try {
			const goItem = item && this.#items.get(item.id);
			if (item && !goItem) {
				// Unknown test item
				return;
			}

			const container = item ? item.children : this.#ctrl.items;
			const children = await (goItem ? this.#provider.getChildren(goItem) : this.#provider.getChildren());
			if (!children) {
				return;
			}

			await container.replace(await Promise.all(children.map(async (x) => this.#getOrCreate(x, container))));
		} finally {
			if (item) item.busy = false;

			debugTree(this.#ctrl.items, item ? `Resolving ${item.id}` : 'Resolving (root)');
		}
	}

	async didChangeTestItem(goItems?: GoTestItem[]) {
		if (!goItems) {
			// Force a refresh by dumping all the roots and resolving
			this.#ctrl.items.replace([]);
			return this.resolve();
		}

		// Create a TestItem for each GoTestItem, including its ancestors
		const items = await Promise.all(goItems.map((x) => this.getOrCreateAll(x)));

		// Refresh
		await Promise.all(items.map((x) => this.resolve(x)));
	}

	async invalidateTestResults(goItems?: GoTestItem[]) {
		if (!this.#ctrl.invalidateTestResults) {
			return; // Older versions of VS Code don't support this
		}
		if (!goItems) {
			this.#ctrl.invalidateTestResults();
			return;
		}
		const items = await Promise.all(goItems.map((x) => this.get(x)));
		this.#ctrl.invalidateTestResults(items.filter((x) => x) as TestItem[]);
	}

	async get(goItem: GoTestItem): Promise<TestItem | undefined> {
		const id = GoTestItem.id(goItem.uri, goItem.kind, goItem.name);
		const parent = await this.#provider.getParent(goItem);
		if (!parent) {
			return this.#ctrl.items.get(id);
		}
		return (await this.get(parent))?.children.get(id);
	}

	async getOrCreateAll(goItem: GoTestItem): Promise<TestItem> {
		const parent = await this.#provider.getParent(goItem);
		const children = !parent ? this.#ctrl.items : (await this.getOrCreateAll(parent)).children;
		return await this.#getOrCreate(goItem, children, true);
	}

	async #getOrCreate(goItem: GoTestItem, children: TestItemCollection, add = false): Promise<TestItem> {
		const id = GoTestItem.id(goItem.uri, goItem.kind, goItem.name);
		this.#items.set(id, goItem);

		const existing = children.get(id);
		const item = existing || this.#ctrl.createTestItem(id, goItem.label, goItem.uri);
		item.canResolveChildren = goItem.hasChildren;
		item.range = goItem.range;
		item.error = goItem.error;

		if (!(goItem instanceof RootItem)) {
			item.tags = [{ id: 'canDebug' }];
		}

		if (add) {
			await children.add(item);
		}

		// Automatically resolve all children of a test case
		if (goItem instanceof TestCase) {
			await this.resolve(item);
		}

		return item;
	}
}

function debugTree(root: TestItemCollection, label: string) {
	if (!debugResolve) return;
	const s = [label];
	const add = (item: TestItem, indent: string) => {
		if (indent === '  ' && item.children.size > 2) {
			console.error('wtf');
		}
		s.push(`${indent}${item.label}`);
		for (const [, child] of item.children) {
			add(child, indent + '  ');
		}
	};
	for (const [, item] of root) {
		add(item, '  ');
	}
	console.log(s.join('\n'));
}
