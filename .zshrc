# Load zsh-hook
autoload -Uz add-zsh-hook

# send osc 654
send_osc654() {
  echo -ne "\033]654;$1\007"
}

# after command, before prompt
precmd_function() {
  local EXIT_CODE=$?
  send_osc654 "exit=$EXIT_CODE:0"
  send_osc654 "prompt"
}

# register hook
add-zsh-hook precmd precmd_function

# send initial message
send_osc654 "interactive"
