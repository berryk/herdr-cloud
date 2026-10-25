# Sourced from /etc/zsh/zshrc. Keeps each Herdr pane's shell state on disk so that after a sleep or
# restart the pane comes back as it was: its folder, the variables, aliases and functions defined in
# it, its screen (saved by save-shells.sh), and the command it was running, ready to run again.
# Processes themselves cannot survive: a snapshot is of the disk only.
# Every command is also logged to ~/.herdr-cloud/commands.log, and a command that changes a project
# under ~/work becomes a journal commit (journal.sh snap).

# History: written as each command runs, not when the shell exits (it is killed at sleep).
# ~/.zshrc runs after this file and can override any of it.
HISTFILE=${HISTFILE:-$HOME/.zsh_history}
(( HISTSIZE >= 50000 )) || HISTSIZE=50000
(( SAVEHIST >= 50000 )) || SAVEHIST=50000
setopt inc_append_history extended_history hist_ignore_dups

[[ -o interactive && -n ${HERDR_PANE_ID-} ]] || return 0
autoload -Uz add-zsh-hook
zmodload zsh/datetime

typeset -g _hc_dir=$HOME/.herdr-cloud/shells/${HERDR_PANE_ID//[^A-Za-z0-9_.-]/_}
# Differs on every container start, so a saved state from another one means this is a restore.
typeset -g _hc_boot="$(</proc/sys/kernel/random/boot_id)-${${=$(</proc/1/stat)}[22]}"
typeset -gA _hc_env _hc_alias _hc_func
typeset -g _hc_last=""
# Set per shell or per prompt, or managed by mise and atuin, so never worth restoring.
typeset -ga _hc_skip=(PWD OLDPWD SHLVL _ COLUMNS LINES PATH HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID)
_hc_skipped() { (( ${_hc_skip[(Ie)$1]} )) || [[ $1 = (__MISE_*|MISE_*|ATUIN_*) ]] }

# What the state looks like once the rc files have run, so only what was set by hand is saved.
_hc_baseline() {
  local k
  _hc_env=() _hc_alias=() _hc_func=()
  for k in ${(k)parameters[(R)*export*]}; do _hc_env[$k]=${(P)k}; done
  _hc_alias=("${(@kv)aliases}")
  _hc_func=("${(@kv)functions}")
}

_hc_state() {
  local k
  print -r -- "# boot=$_hc_boot"
  print -r -- "builtin cd -q -- ${(q)PWD} 2>/dev/null"
  for k in ${(k)parameters[(R)*export*]}; do
    _hc_skipped $k && continue
    [[ ${+_hc_env[$k]} = 1 && ${_hc_env[$k]} = ${(P)k} ]] || print -r -- "export $k=${(qq)${(P)k}}"
  done
  for k in ${(k)_hc_env}; do
    _hc_skipped $k || [[ ${parameters[$k]-} = *export* ]] || print -r -- "unset $k"
  done
  for k in ${(k)aliases}; do
    [[ ${_hc_alias[$k]-} = ${aliases[$k]} ]] || alias -L -- $k
  done
  for k in ${(k)functions}; do
    [[ $k = [_+]* || $k = (TRAP|prompt_|starship|mise|atuin)* || ${_hc_func[$k]-} = ${functions[$k]} ]] || functions -- $k
  done
}

# Each prompt: rewrite the state only when it changed, as the per-minute sync uploads changed files.
_hc_save() {
  rm -f $_hc_dir/running
  local s=$(_hc_state)
  [[ $s = $_hc_last ]] && return
  print -r -- $s >| $_hc_dir/state.tmp && mv -f $_hc_dir/state.tmp $_hc_dir/state && _hc_last=$s
}

typeset -g _hc_cmd=""
typeset -gF _hc_t0
_hc_running() {
  [[ $1 = (exit|logout)* ]] || print -r -- $1 >| $_hc_dir/running
  _hc_cmd=$1 _hc_t0=$EPOCHREALTIME
}

# Runs first among the precmd hooks, so $? is still the command's.
_hc_done() {
  local code=$?
  [[ -n $_hc_cmd ]] || return 0
  local cmd=${_hc_cmd//$'\n'/ ⏎ } secs=$(( int(EPOCHREALTIME - _hc_t0) ))
  _hc_cmd=""
  print -r -- "$(strftime %FT%TZ $EPOCHSECONDS)	$HERDR_PANE_ID	$code	${secs}s	$PWD	$cmd" >> $HOME/.herdr-cloud/commands.log
  if [[ $PWD = $HOME/work/?* && -x /opt/herdr-cloud/journal.sh ]]; then
    TZ=UTC /opt/herdr-cloud/journal.sh snap $PWD "shell: ${cmd[1,100]} (exit $code, ${secs}s)" >/dev/null 2>&1 &!
  fi
}

# First prompt, after ~/.zshrc: take the baseline, then lay a state from an earlier start on top.
_hc_restore() {
  add-zsh-hook -d precmd _hc_restore
  mkdir -p $_hc_dir
  _hc_baseline
  local state=$_hc_dir/state saved
  [[ -r $state ]] && read -r saved < $state
  if [[ -n $saved && $saved != "# boot=$_hc_boot" ]]; then
    if [[ -s $_hc_dir/screen ]]; then
      cat $_hc_dir/screen
      print -P "\n%F{8}── restored after a restart, $(date -r $_hc_dir/screen '+%a %H:%M') ──%f"
    fi
    source $state
    local cmd
    [[ -s $_hc_dir/running ]] && cmd=$(<$_hc_dir/running)
    # restore-layout.sh restarts Claude itself.
    if [[ -n $cmd && $cmd != claude* ]]; then
      print -P "%F{8}was running: press Enter to run it again%f"
      print -z -- $cmd
    fi
  fi
  rm -f $_hc_dir/screen $_hc_dir/running
}

precmd_functions=(_hc_done $precmd_functions)
add-zsh-hook precmd _hc_restore
add-zsh-hook precmd _hc_save
add-zsh-hook preexec _hc_running
