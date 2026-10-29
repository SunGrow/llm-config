-- Syntax check for post-edit.mjs when no luac is installed: nvim --clean --headless -l lua-check.lua <file>
local f, err = loadfile(arg[1])
if not f then
  io.stderr:write(err, '\n')
  os.exit(1)
end
