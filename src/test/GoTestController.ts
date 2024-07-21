/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	commands,
	Disposable,
	Event,
	ExtensionContext,
	ExtensionMode,
	extensions,
	TestController,
	TestItem,
	TestRunProfileKind,
	tests,
	Uri,
	window,
	workspace
} from 'vscode';
import { Context, doSafe, SetupArgs } from './testSupport';
import { safeInvalidate, TestItemResolver } from './TestItemResolver';
import { GoTestItem, GoTestItemProvider } from './GoTestItem';
import { GoTestRunner } from './GoTestRunner';
import { ExtensionAPI } from '../vscode-go';
import { debugProcess, spawnProcess } from './utils';

export async function registerTestController(ctx: ExtensionContext) {
	// The Go extension _must_ be activated first since we depend on gopls
	const goExt = extensions.getExtension<ExtensionAPI>('golang.go');
	if (!goExt) {
		throw new Error('Cannot activate without the Go extension');
	}
	const go = await goExt.activate();

	const testCtx: Context = {
		workspace,
		go,
		spawn: spawnProcess,
		debug: debugProcess,
		testing: ctx.extensionMode === ExtensionMode.Test,
		output: window.createOutputChannel('Go Tests (experimental)', { log: true }),
		commands: {
			modules: (args) => commands.executeCommand('gopls.modules', args),
			packages: (args) => commands.executeCommand('gopls.packages', args),
			focusTestOutput: () => commands.executeCommand('testing.showMostRecentOutput')
		}
	};

	const event = <T>(event: Event<T>, msg: string, fn: (e: T) => unknown) => {
		ctx.subscriptions.push(event((e) => doSafe(testCtx, msg, () => fn(e))));
	};
	const command = (name: string, fn: (...args: any[]) => any) => {
		ctx.subscriptions.push(
			commands.registerCommand(name, (...args) => doSafe(testCtx, `executing ${name}`, () => fn(...args)))
		);
	};

	// Initialize the controller
	const ctrl = new GoTestController(testCtx);
	const setup = () => {
		ctrl.setup({ createController: tests.createTestController });
		window.visibleTextEditors.forEach((x) => ctrl.reload(x.document.uri));
	};
	ctx.subscriptions.push(ctrl);

	// [Command] Refresh
	command('goExp.testExplorer.refresh', (item) => ctrl.enabled && ctrl.reload(item));

	// [Event] Configuration change
	event(workspace.onDidChangeConfiguration, 'changed configuration', async (e) => {
		if (e.affectsConfiguration('goExp.testExplorer.enable')) {
			const enabled = workspace.getConfiguration('goExp').get<boolean>('testExplorer.enable');
			if (enabled === ctrl.enabled) {
				return;
			}
			if (enabled) {
				setup();
			} else {
				ctrl.dispose();
			}
		}
		if (!ctrl.enabled) {
			return;
		}
		if (
			e.affectsConfiguration('goExp.testExplorer.discovery') ||
			e.affectsConfiguration('goExp.testExplorer.showFiles') ||
			e.affectsConfiguration('goExp.testExplorer.nestPackages')
		) {
			await ctrl.reload();
		}
	});

	// [Event] File open
	event(workspace.onDidOpenTextDocument, 'opened document', (e) => ctrl.enabled && ctrl.reload(e.uri));

	// [Event] File change
	event(
		workspace.onDidChangeTextDocument,
		'updated document',
		(e) => ctrl.enabled && ctrl.reload(e.document.uri, true)
	);

	// [Event] Workspace change
	event(workspace.onDidChangeWorkspaceFolders, 'changed workspace', async () => ctrl.enabled && ctrl.reload());

	// [Event] File created/deleted
	const watcher = workspace.createFileSystemWatcher('**/*_test.go', false, true, false);
	ctx.subscriptions.push(watcher);
	event(watcher.onDidCreate, 'created file', async (e) => ctrl.enabled && ctrl.reload(e));
	event(watcher.onDidDelete, 'deleted file', async (e) => ctrl.enabled && ctrl.reload(e));

	// Setup the controller (if enabled)
	if (workspace.getConfiguration('goExp').get<boolean>('testExplorer.enable')) {
		setup();
	}
}

class GoTestController {
	readonly #context: Context;
	readonly #provider: GoTestItemProvider;
	readonly #disposable: Disposable[] = [];

	constructor(context: Context) {
		this.#context = context;
		this.#provider = new GoTestItemProvider(context);
	}

	#ctrl?: TestController;
	#resolver?: TestItemResolver<GoTestItem>;

	get enabled() {
		return !!this.#ctrl;
	}

	setup(args: SetupArgs) {
		this.#ctrl = args.createController('goExp', 'Go (experimental)');
		const resolver = new TestItemResolver(this.#ctrl, this.#provider);
		this.#resolver = resolver;
		this.#disposable.push(this.#ctrl, this.#resolver);

		this.#ctrl.refreshHandler = () => doSafe(this.#context, 'refresh tests', () => resolver.resolve());
		this.#ctrl.resolveHandler = (item) => doSafe(this.#context, 'resolve test', () => resolver.resolve(item));
		new GoTestRunner(this.#context, this.#ctrl, resolver, 'Go', TestRunProfileKind.Run, true);
		new GoTestRunner(this.#context, this.#ctrl, resolver, 'Go (debug)', TestRunProfileKind.Debug, true);
	}

	dispose() {
		this.#disposable.forEach((x) => x.dispose());
		this.#disposable.splice(0, this.#disposable.length);
		this.#ctrl = undefined;
		this.#resolver = undefined;
	}

	reload(item?: Uri | TestItem, invalidate = false) {
		if (!item || item instanceof Uri) {
			this.#provider.reload(item, invalidate);
			return;
		}

		this.#resolver?.resolve(item);
		if (invalidate && this.#ctrl) {
			safeInvalidate(this.#ctrl, item);
		}
	}
}
