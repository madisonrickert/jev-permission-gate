// Session state that must survive a hot reload of the hooks module.

/** A permission mode as classic hook inputs report it (`auto`, `default`, ...). */
export type PermissionModeName = string

declare module 'claude-code' {
  interface PluginState {
    'jev-permission-gate': {
      /** The permission mode last seen on a classic hook input. */
      mode: PermissionModeName | null
      /** The last few messages other sessions sent this one. */
      peers: string[]
    }
  }
}
