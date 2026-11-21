// @rms/sdk: the only way a mini-app's screens reach RMS.
//
// The frame side of the hand-off in @rms/contracts frame.ts (ADR 0008): announce `rms.ready`,
// take `rms.init` from the one allowed parent origin, send `rms.data` and match the answers by
// id. A typed data client over it, and React hooks for screens.
//
// The SDK never holds a token and never calls the network: no fetch, no XMLHttpRequest, no
// WebSocket, no storage, no cookies. It only posts messages to its parent, and only to the
// origin it was built with. A test reads this package's source to keep it that way.
import { FRAME_PROTOCOL } from "@rms/contracts";

export { defineApp } from "@rms/contracts";
export type { AppManifestInput, FrameContext, Row } from "@rms/contracts";

export { connect } from "./frame";
export type { Connection, ConnectOptions, FrameWindow, NotConnectedReason } from "./frame";
export { DataClient, RmsDataError } from "./client";
export type { BatchInput, BatchResult, CatalogResult, NamedActionInput, NamedActionResult, NamedQueryInput, NamedQueryResult, QueryInput, QueryResult } from "./client";
export { RmsProvider, useMutation, useNamedQuery, useQuery, useRms, useRmsClient } from "./react";
export type { RmsProviderProps, UseMutationResult, UseNamedQueryResult, UseQueryResult } from "./react";
export { addDays, dateFromToday, formatAs, formatDate, formatMoney, formatNumber, formatPercent, fromInput, humanize, moneyToMinor, showValue, toInput } from "./format";
export type { FromInput, Place } from "./format";
export { allLocationsRows, lastFinishedRow } from "./rows";

/** The hand-off protocol this SDK speaks. */
export const SDK_PROTOCOL = FRAME_PROTOCOL;
