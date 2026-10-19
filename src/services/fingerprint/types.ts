/**
 * What a fingerprint reader has to look like from the application's side.
 *
 * Modelled on `services/gateways`: one file per vendor, a registry that picks
 * between them, and nothing above this layer knowing which one is plugged in.
 *
 * The shape is dictated by a fact about the hardware rather than by taste.
 * Readers fall into two camps, and the difference decides where matching
 * happens:
 *
 *   - **Standalone readers** (ZKTeco and most of what a Pakistani gym will
 *     actually buy) hold their own template store and match internally. Ask
 *     them who this finger is and they answer with an id.
 *   - **Bare scanners** hand over a template and nothing else. Matching is the
 *     caller's problem, against templates it has kept itself.
 *
 * `identify` covers the first, `capture` plus `match` the second, and
 * `matchesLocally` says which pair this device honours. Writing both into one
 * interface is what lets the controller, the routes and the UI be finished
 * before the hardware is chosen — the shape of the answer is the same either
 * way, only who computed it differs.
 */

/** An enrolled finger, as the reader encodes it. Never an image. */
export interface Template {
  /**
   * The reader's own opaque encoding. Vendors do not agree on a format and
   * none of them document theirs, so nothing above this layer may read it.
   */
  data: Buffer;
  /**
   * Whose encoding this is — `"zkteco-v10"`, `"suprema-v2"`. Stored alongside
   * the template so a gym that swaps readers gets told its enrolments are
   * unreadable, rather than finding out as a morning where no finger works.
   */
  format: string;
}

/** What the device made of a finger placed on it. */
export type CaptureResult =
  | { ok: true; template: Template; /** 0-100, the reader's own confidence in the scan. */ quality: number }
  | { ok: false; reason: CaptureFailure };

/**
 * Why a scan produced nothing usable.
 *
 * An enumeration rather than a string because the front desk needs different
 * words for each: "press a little harder" is useful, "capture failed" is not.
 */
export type CaptureFailure =
  | 'no_finger'
  | 'poor_quality'
  | 'device_offline'
  | 'timeout'
  | 'error';

/** Who the device thinks is standing there. */
export type IdentifyResult =
  /** Matched an enrolled finger. `externalId` is whatever was passed to
   *  `enroll` — this application always passes a member id. */
  | { ok: true; externalId: string; score: number }
  /** A finger was read and is not enrolled. Not an error: an unenrolled
   *  member putting a finger on the reader is an ordinary Tuesday. */
  | { ok: false; reason: 'no_match' }
  | { ok: false; reason: CaptureFailure };

export interface FingerprintDevice {
  /** Identifier for logs and the health endpoint. */
  readonly id: string;
  /** Human name, shown in the UI when the device is unreachable. */
  readonly label: string;
  /** The `format` string every template this device produces will carry. */
  readonly format: string;

  /**
   * Whether the device is configured — has an address, credentials, a driver.
   * Checked before anything is attempted, so an unconfigured reader shows as
   * "not set up" rather than as a timeout thirty seconds into a check-in.
   */
  isConfigured(): boolean;

  /** Whether the device is configured *and* answering right now. */
  isOnline(): Promise<boolean>;

  /**
   * True when the device holds its own template store and matches internally.
   *
   * Decides which half of this interface the caller uses:
   *   - `true`  → `identify` answers directly; `enroll`/`forget` keep the
   *     device's own store in step. Templates still come back so the database
   *     has a copy to re-provision a replacement device from.
   *   - `false` → `capture` returns a template and `match` compares it against
   *     the templates the caller supplies from the database.
   */
  readonly matchesLocally: boolean;

  /**
   * Read a finger and return its template without matching anything.
   *
   * Used for enrolment on every device, and for check-in on devices that do
   * not match locally.
   */
  capture(opts?: { timeoutMs?: number }): Promise<CaptureResult>;

  /**
   * Ask the device who is at the reader. Only meaningful when
   * `matchesLocally` is true.
   */
  identify(opts?: { timeoutMs?: number }): Promise<IdentifyResult>;

  /**
   * Compare one template against a set of candidates. Only meaningful when
   * `matchesLocally` is false.
   *
   * Returns the best candidate above the vendor's threshold, or `no_match`.
   * The threshold belongs to the vendor and is deliberately not a parameter:
   * scores are not comparable between makes, so a number chosen here would
   * mean something different on every device.
   */
  match(
    probe: Template,
    candidates: readonly { externalId: string; template: Template }[],
  ): Promise<IdentifyResult>;

  /**
   * Register a template against an id in the device's own store. A no-op on
   * devices that do not match locally.
   *
   * Enrolling an id that already exists replaces it, matching the database,
   * where re-enrolment overwrites rather than accumulating.
   */
  enroll(externalId: string, template: Template): Promise<void>;

  /** Remove an id from the device's store. Must not throw if it is absent —
   *  deleting something that is already gone is a success, not a failure. */
  forget(externalId: string): Promise<void>;

  /**
   * True when the finger is taken on the device itself — its own screen walks
   * the member through placing the same finger several times and says whether
   * each one was right. Such a device never hands a template back, so
   * `capture` cannot be used to enrol on it; `beginDeviceEnrol` and
   * `hasDeviceEnrolment` are used instead.
   */
  readonly enrolOnDevice?: boolean;

  /**
   * Register the member on the device and put it in enrolment mode, so the
   * next fingers placed on it are taken for this member. Returns once the
   * device has accepted the request, not once the finger is taken — the desk
   * watches the device for that.
   */
  beginDeviceEnrol?(
    externalId: string,
    opts: { name: string; finger?: number },
  ): Promise<{ deviceUserId: string }>;

  /** Whether the device now holds this member, i.e. enrolment was started. */
  hasDeviceEnrolment?(externalId: string): Promise<boolean>;
}
