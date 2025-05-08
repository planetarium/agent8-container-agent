# Load zsh-hook
autoload -Uz add-zsh-hook

# send osc 654
send_osc654() {
  echo -ne "\033]654;$1\007"
}

# detect first run
JSH_EMULATOR_FIRST_RUN=1

# after command, before prompt
precmd_function() {
  local EXIT_CODE=$?

  # when first run, set flag to 0 and do nothing
  if [[ $JSH_EMULATOR_FIRST_RUN -eq 1 ]]; then
    JSH_EMULATOR_FIRST_RUN=0
    return
  fi

  send_osc654 "exit=$EXIT_CODE:0"
  send_osc654 "prompt"
}

# register hook
add-zsh-hook precmd precmd_function

# send initial message
send_osc654 "interactive"
