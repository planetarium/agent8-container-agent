# Load zsh-hook
autoload -Uz add-zsh-hook

# send osc 654
send_osc654() {
  echo -ne "\033]654;$1\007"
}

# detect first run
JSH_EMULATOR_FIRST_RUN=1

# prevent duplicate OSC messages
JSH_OSC_SENT=0

# after command, before prompt
precmd_function() {
  local EXIT_CODE=$?
  
  # if TRAPINT already sent OSC, skip this execution
  if [[ $JSH_OSC_SENT -eq 1 ]]; then
    JSH_OSC_SENT=0  # reset flag
    return
  fi

  # when first run, set flag to 0 and do nothing
  if [[ $JSH_EMULATOR_FIRST_RUN -eq 1 ]]; then
    JSH_EMULATOR_FIRST_RUN=0
    return
  fi

  send_osc654 "exit=$EXIT_CODE:0"
  send_osc654 "prompt"
}

# Handle SIGINT (Ctrl+C)
TRAPINT() {
  # send OSC messages for interrupt
  send_osc654 "exit=130:0"
  send_osc654 "prompt"
  
  # set flag to prevent duplicate execution in precmd
  JSH_OSC_SENT=1
  
  # return proper SIGINT exit code
  return $(( 128 + 2 ))
}

# register hook
add-zsh-hook precmd precmd_function

# send initial message
send_osc654 "interactive"
