declare module 'claude-code' {
  interface PluginState {
    // 読んでいるプロンプトが動いたら増やす。帯とペインが描くときに読むので、増やすとその 2 つだけが描き直される。
    'prompt-trail': { moved: number }
  }
}
