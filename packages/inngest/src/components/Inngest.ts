import { InngestApi } from "../api/api";
import {
  defaultInngestBaseUrl,
  defaultInngestEventBaseUrl,
  envKeys,
  logPrefix,
} from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import {
  devServerHost,
  getFetch,
  inngestHeaders,
  processEnv,
  skipDevServer,
} from "../helpers/env";
import { fixEventKeyMissingSteps, prettyError } from "../helpers/errors";
import { stringify } from "../helpers/strings";
import { type ExclusiveKeys, type SendEventPayload } from "../helpers/types";
import { DefaultLogger, ProxyLogger, type Logger } from "../middleware/logger";
import {
  type AnyHandler,
  type ClientOptions,
  type EventNameFromTrigger,
  type EventPayload,
  type FailureEventArgs,
  type FunctionOptions,
  type FunctionTrigger,
  type Handler,
  type MiddlewareStack,
  type TriggerOptions,
} from "../types";
import { type EventSchemas } from "./EventSchemas";
import { InngestFunction } from "./InngestFunction";
import {
  InngestMiddleware,
  getHookStack,
  type ExtendWithMiddleware,
  type MiddlewareOptions,
  type MiddlewareRegisterFn,
  type MiddlewareRegisterReturn,
} from "./InngestMiddleware";

/**
 * Capturing the global type of fetch so that we can reliably access it below.
 */
type FetchT = typeof fetch;

/**
 * Given a set of client options for Inngest, return the event types that can
 * be sent or received.
 *
 * @public
 */
export type EventsFromOpts<TOpts extends ClientOptions> =
  TOpts["schemas"] extends EventSchemas<infer U>
    ? U
    : Record<string, EventPayload>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInngest = Inngest<any>;

/**
 * A client used to interact with the Inngest API by sending or reacting to
 * events.
 *
 * To provide event typing, see {@link EventSchemas}.
 *
 * ```ts
 * const inngest = new Inngest({ name: "My App" });
 *
 * // or to provide event typing too
 * const inngest = new Inngest({
 *   name: "My App",
 *   schemas: new EventSchemas().fromRecord<{
 *     "app/user.created": {
 *       data: { userId: string };
 *     };
 *   }>(),
 * });
 * ```
 *
 * @public
 */
export class Inngest<TOpts extends ClientOptions = ClientOptions> {
  /**
   * The ID of this instance, most commonly a reference to the application it
   * resides in.
   *
   * The ID of your client should remain the same for its lifetime; if you'd
   * like to change the name of your client as it appears in the Inngest UI,
   * change the `name` property instead.
   */
  public readonly id: string;

  /**
   * Inngest event key, used to send events to Inngest Cloud.
   */
  private eventKey = "";

  private readonly baseUrl: string | undefined;

  private readonly inngestApi: InngestApi;

  /**
   * The absolute URL of the Inngest Cloud API.
   */
  private sendEventUrl: URL = new URL(
    `e/${this.eventKey}`,
    defaultInngestEventBaseUrl
  );

  private readonly headers: Record<string, string>;

  private readonly fetch: FetchT;

  private readonly logger: Logger;

  /**
   * A promise that resolves when the middleware stack has been initialized and
   * the client is ready to be used.
   */
  private readonly middleware: Promise<MiddlewareRegisterReturn[]>;

  /**
   * A client used to interact with the Inngest API by sending or reacting to
   * events.
   *
   * To provide event typing, see {@link EventSchemas}.
   *
   * ```ts
   * const inngest = new Inngest({ name: "My App" });
   *
   * // or to provide event typing too
   * const inngest = new Inngest({
   *   name: "My App",
   *   schemas: new EventSchemas().fromRecord<{
   *     "app/user.created": {
   *       data: { userId: string };
   *     };
   *   }>(),
   * });
   * ```
   */
  constructor({
    id,
    eventKey,
    baseUrl,
    fetch,
    env,
    logger = new DefaultLogger(),
    middleware,
  }: TOpts) {
    if (!id) {
      // TODO PrettyError
      throw new Error("An `id` must be passed to create an Inngest instance.");
    }

    this.id = id;

    this.baseUrl = baseUrl || processEnv(envKeys.InngestBaseUrl);

    this.setEventKey(eventKey || processEnv(envKeys.InngestEventKey) || "");

    if (!this.eventKey) {
      console.warn(
        prettyError({
          type: "warn",
          whatHappened: "Could not find event key",
          consequences:
            "Sending events will throw in production unless an event key is added.",
          toFixNow: fixEventKeyMissingSteps,
          why: "We couldn't find an event key to use to send events to Inngest.",
          otherwise:
            "Create a new production event key at https://app.inngest.com/env/production/manage/keys.",
        })
      );
    }

    this.headers = inngestHeaders({
      inngestEnv: env,
    });

    this.fetch = getFetch(fetch);

    this.inngestApi = new InngestApi({
      baseUrl: this.baseUrl || defaultInngestBaseUrl,
      signingKey: processEnv(envKeys.InngestSigningKey) || "",
      fetch: this.fetch,
    });

    this.logger = logger;

    this.middleware = this.initializeMiddleware([
      ...builtInMiddleware,
      ...(middleware || []),
    ]);
  }

  /**
   * Initialize all passed middleware, running the `register` function on each
   * in sequence and returning the requested hook registrations.
   */
  private async initializeMiddleware(
    middleware: InngestMiddleware<MiddlewareOptions>[] = [],
    opts?: {
      registerInput?: Omit<Parameters<MiddlewareRegisterFn>[0], "client">;
      prefixStack?: Promise<MiddlewareRegisterReturn[]>;
    }
  ): Promise<MiddlewareRegisterReturn[]> {
    /**
     * Wait for the prefix stack to run first; do not trigger ours before this
     * is complete.
     */
    const prefix = await (opts?.prefixStack ?? []);

    const stack = middleware.reduce<Promise<MiddlewareRegisterReturn[]>>(
      async (acc, m) => {
        // Be explicit about waiting for the previous middleware to finish
        const prev = await acc;
        const next = await m.init({ client: this, ...opts?.registerInput });

        return [...prev, next];
      },
      Promise.resolve([])
    );

    return [...prefix, ...(await stack)];
  }

  /**
   * Given a response from Inngest, relay the error to the caller.
   */
  async #getResponseError(response: globalThis.Response): Promise<Error> {
    let errorMessage = "Unknown error";
    switch (response.status) {
      case 401:
        errorMessage = "Event key Not Found";
        break;
      case 400:
        errorMessage = "Cannot process event payload";
        break;
      case 403:
        errorMessage = "Forbidden";
        break;
      case 404:
        errorMessage = "Event key not found";
        break;
      case 406:
        errorMessage = `${JSON.stringify(await response.json())}`;
        break;
      case 409:
      case 412:
        errorMessage = "Event transformation failed";
        break;
      case 413:
        errorMessage = "Event payload too large";
        break;
      case 500:
        errorMessage = "Internal server error";
        break;
      default:
        errorMessage = await response.text();
        break;
    }

    return new Error(`Inngest API Error: ${response.status} ${errorMessage}`);
  }

  /**
   * Set the event key for this instance of Inngest. This is useful if for some
   * reason the key is not available at time of instantiation or present in the
   * `INNGEST_EVENT_KEY` environment variable.
   */
  public setEventKey(
    /**
     * Inngest event key, used to send events to Inngest Cloud. Use this is your
     * key is for some reason not available at time of instantiation or present
     * in the `INNGEST_EVENT_KEY` environment variable.
     */
    eventKey: string
  ): void {
    this.eventKey = eventKey;

    this.sendEventUrl = new URL(
      `e/${this.eventKey}`,
      this.baseUrl || defaultInngestEventBaseUrl
    );
  }

  /**
   * Send one or many events to Inngest. Takes an entire payload (including
   * name) as each input.
   *
   * ```ts
   * await inngest.send({ name: "app/user.created", data: { id: 123 } });
   * ```
   *
   * Returns a promise that will resolve if the event(s) were sent successfully,
   * else throws with an error explaining what went wrong.
   *
   * If you wish to send an event with custom types (i.e. one that hasn't been
   * generated), make sure to add it when creating your Inngest instance, like
   * so:
   *
   * ```ts
   * const inngest = new Inngest({
   *   name: "My App",
   *   schemas: new EventSchemas().fromRecord<{
   *     "my/event": {
   *       name: "my/event";
   *       data: { bar: string };
   *     };
   *   }>(),
   * });
   * ```
   */
  public async send<Payload extends SendEventPayload<EventsFromOpts<TOpts>>>(
    payload: Payload
  ): Promise<void> {
    const hooks = await getHookStack(
      this.middleware,
      "onSendEvent",
      undefined,
      {
        transformInput: (prev, output) => {
          return { ...prev, ...output };
        },
        transformOutput: (prev, _output) => {
          return prev;
        },
      }
    );

    if (!this.eventKey) {
      throw new Error(
        prettyError({
          whatHappened: "Failed to send event",
          consequences: "Your event or events were not sent to Inngest.",
          why: "We couldn't find an event key to use to send events to Inngest.",
          toFixNow: fixEventKeyMissingSteps,
        })
      );
    }

    let payloads: EventPayload[] = Array.isArray(payload)
      ? (payload as EventPayload[])
      : payload
      ? ([payload] as [EventPayload])
      : [];

    const inputChanges = await hooks.transformInput?.({
      payloads: [...payloads],
    });
    if (inputChanges?.payloads) {
      payloads = [...inputChanges.payloads];
    }

    // Ensure that we always add a "ts" field to events.  This is auto-filled by the
    // event server so is safe, and adding here fixes Next.js server action cache issues.
    payloads = payloads.map((p) =>
      p.ts ? p : { ...p, ts: new Date().getTime() }
    );

    /**
     * It can be valid for a user to send an empty list of events; if this
     * happens, show a warning that this may not be intended, but don't throw.
     */
    if (!payloads.length) {
      return console.warn(
        prettyError({
          type: "warn",
          whatHappened: "`inngest.send()` called with no events",
          reassurance:
            "This is not an error, but you may not have intended to do this.",
          consequences:
            "The returned promise will resolve, but no events have been sent to Inngest.",
          stack: true,
        })
      );
    }

    // When sending events, check if the dev server is available.  If so, use the
    // dev server.
    let url = this.sendEventUrl.href;

    if (!skipDevServer()) {
      const host = devServerHost();
      // If the dev server host env var has been set we always want to use
      // the dev server - even if it's down.  Otherwise, optimistically use
      // it for non-prod services.
      if (host !== undefined || (await devServerAvailable(host, this.fetch))) {
        url = devServerUrl(host, `e/${this.eventKey}`).href;
      }
    }

    const response = await this.fetch(url, {
      method: "POST",
      body: stringify(payloads),
      headers: { ...this.headers },
    });

    if (response.status >= 200 && response.status < 300) {
      return void (await hooks.transformOutput?.({ payloads: [...payloads] }));
    }

    throw await this.#getResponseError(response);
  }

  public createFunction<
    TMiddleware extends MiddlewareStack,
    TTrigger extends TriggerOptions<keyof EventsFromOpts<TOpts> & string>,
    TTriggerName extends keyof EventsFromOpts<TOpts> &
      string = EventNameFromTrigger<EventsFromOpts<TOpts>, TTrigger>
  >(
    options: ExclusiveKeys<
      Omit<
        FunctionOptions<EventsFromOpts<TOpts>, TTriggerName>,
        "onFailure" | "middleware"
      > & {
        /**
         * Provide a function to be called if your function fails, meaning
         * that it ran out of retries and was unable to complete successfully.
         *
         * This is useful for sending warning notifications or cleaning up
         * after a failure and supports all the same functionality as a
         * regular handler.
         */
        onFailure?: Handler<
          TOpts,
          EventsFromOpts<TOpts>,
          TTriggerName,
          ExtendWithMiddleware<
            [
              typeof builtInMiddleware,
              NonNullable<TOpts["middleware"]>,
              TMiddleware
            ],
            FailureEventArgs<EventsFromOpts<TOpts>[TTriggerName]>
          >
        >;

        /**
         * Define a set of middleware that can be registered to hook into
         * various lifecycles of the SDK and affect input and output of
         * Inngest functionality.
         *
         * See {@link https://innge.st/middleware}
         *
         * @example
         *
         * ```ts
         * export const inngest = new Inngest({
         *   middleware: [
         *     new InngestMiddleware({
         *       name: "My Middleware",
         *       init: () => {
         *         // ...
         *       }
         *     })
         *   ]
         * });
         * ```
         */
        middleware?: TMiddleware;
      },
      "batchEvents",
      "cancelOn" | "rateLimit"
    >,
    trigger: TTrigger,
    handler: Handler<
      TOpts,
      EventsFromOpts<TOpts>,
      TTriggerName,
      ExtendWithMiddleware<
        [
          typeof builtInMiddleware,
          NonNullable<TOpts["middleware"]>,
          TMiddleware
        ]
      >
    >
  ): InngestFunction<
    TOpts,
    EventsFromOpts<TOpts>,
    FunctionTrigger<keyof EventsFromOpts<TOpts> & string>,
    FunctionOptions<EventsFromOpts<TOpts>, keyof EventsFromOpts<TOpts> & string>
  > {
    let sanitizedOpts: FunctionOptions<
      EventsFromOpts<TOpts>,
      keyof EventsFromOpts<TOpts> & string
    >;

    if (typeof options === "string") {
      // v2 -> v3 runtime migraton warning
      console.warn(
        `${logPrefix} InngestFunction: Creating a function with a string as the first argument has been deprecated in v3; pass an object instead. See https://www.inngest.com/docs/sdk/migration`
      );

      sanitizedOpts = { id: options };
    } else {
      sanitizedOpts = options as typeof sanitizedOpts;
    }

    let sanitizedTrigger: FunctionTrigger<keyof EventsFromOpts<TOpts> & string>;
    if (trigger.event) {
      sanitizedTrigger = {
        event: trigger.event,
        expression: trigger.if,
      };
    } else {
      sanitizedTrigger = trigger;
    }

    if (Object.hasOwnProperty.call(sanitizedOpts, "fns")) {
      // v2 -> v3 migration warning
      console.warn(
        `${logPrefix} InngestFunction: \`fns\` option has been deprecated in v3; use \`middleware\` instead. See https://www.inngest.com/docs/sdk/migration`
      );
    }

    return new InngestFunction(
      this,
      sanitizedOpts,
      sanitizedTrigger,
      handler as AnyHandler
    );
  }
}

/**
 * Default middleware that is included in every client, placed after the user's
 * middleware on the client but before function-level middleware.
 *
 * It is defined here to ensure that comments are included in the generated TS
 * definitions. Without this, we infer the stack of built-in middleware without
 * comments, losing a lot of value.
 *
 * If this is moved, please ensure that using this package in another project
 * can correctly access comments on mutated input and output.
 */
const builtInMiddleware = (<T extends MiddlewareStack>(m: T): T => m)([
  new InngestMiddleware({
    name: "Inngest: Logger",
    init({ client }) {
      return {
        onFunctionRun(arg) {
          const { ctx } = arg;
          const metadata = {
            runID: ctx.runId,
            eventName: ctx.event.name,
            functionName: arg.fn.name,
          };

          let providedLogger: Logger = client["logger"];
          // create a child logger if the provided logger has child logger implementation
          try {
            if ("child" in providedLogger) {
              type ChildLoggerFn = (
                metadata: Record<string, unknown>
              ) => Logger;
              providedLogger = (providedLogger.child as ChildLoggerFn)(
                metadata
              );
            }
          } catch (err) {
            console.error('failed to create "childLogger" with error: ', err);
            // no-op
          }
          const logger = new ProxyLogger(providedLogger);

          return {
            transformInput() {
              return {
                ctx: {
                  /**
                   * The passed in logger from the user.
                   * Defaults to a console logger if not provided.
                   */
                  logger: logger as Logger,
                },
              };
            },
            beforeExecution() {
              logger.enable();
            },
            transformOutput({ result: { error } }) {
              if (error) {
                logger.error(error);
              }
            },
            async beforeResponse() {
              await logger.flush();
            },
          };
        },
      };
    },
  }),
]);
