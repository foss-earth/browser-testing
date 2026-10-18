#!/bin/bash
# Lists, and with --clean removes, the copies of its app bundle that Google
# Chrome (and other Chromium browsers) leave under
# /private/var/folders/…/X/<bundle id>.code_sign_clone/ when they are killed
# instead of quitting. A clone that a running browser still owns is never
# touched. Why they appear: docs/validation/chrome-code-sign-clones.md in
# foss-earth/docs.
set -u

usage() {
  cat <<'EOF'
Usage: chrome-clones.sh [--clean]

Without options, lists every code-sign clone and whether a running browser
still owns it. With --clean, removes the stranded ones and reports how much
disk space came back.
EOF
}

clean=0
case "${1:-}" in
  "") ;;
  --clean) clean=1 ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [ "$(uname)" != Darwin ]; then
  echo "Code-sign clones exist only on macOS."
  exit 0
fi

export LC_ALL=C
temp_dir=$(getconf DARWIN_USER_TEMP_DIR) || exit 1
x_dir=$(cd "$temp_dir../X" 2>/dev/null && pwd -P) || x_dir=""

# Grouped by browser, oldest first.
clones=()
if [ -n "$x_dir" ]; then
  while IFS=$'\t' read -r _ _ clone; do
    [ -d "$clone" ] && clones+=("$clone")
  done < <(for clone in "$x_dir"/*.code_sign_clone/code_sign_clone.*; do
    [ -d "$clone" ] && printf '%s\t%s\t%s\n' "$(dirname "$clone")" "$(stat -f %B "$clone")" "$clone"
  done | sort -t $'\t' -k1,1 -k2,2n)
fi
if [ ${#clones[@]} -eq 0 ]; then
  echo "No code-sign clones under ${x_dir:-${temp_dir}../X}."
  exit 0
fi

# A browser makes its clone a moment after it starts, so a clone born within
# this window after a running browser's start may be that browser's. Clones
# born in the window are kept, even if a second, killed browser made one of
# them at the same time; a later run removes it once the browser has quit.
before_start=5
after_start=600

plist_value() { /usr/libexec/PlistBuddy -c "Print $2" "$1/Contents/Info.plist" 2>/dev/null; }

# Prints the app bundle inside a clone; nothing while the browser is still
# making the clone.
clone_bundle() {
  for candidate in "$1"/*.app.bundle; do
    [ -f "$candidate/Contents/Info.plist" ] && echo "$candidate" && return
  done
}

# Prints "pid start-epoch" for each running process whose executable is
# <somewhere>/<app>/Contents/MacOS/<exe>.
running_browsers() {
  ps -axo pid=,lstart=,comm= | while read -r pid weekday month day time year comm; do
    case "$comm" in */"$1"/Contents/MacOS/"$2") ;; *) continue ;; esac
    echo "$pid $(date -j -f '%a %b %d %T %Y' "$weekday $month $day $time $year" +%s)"
  done
}

human() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else printf "%.0f MB", k / 1024 }'; }

echo "Code-sign clones in $x_dir"
stranded=()
stranded_kb=0
old_version_kb=0
family=""
now=$(date +%s)
for clone in "${clones[@]}"; do
  if [ "$(dirname "$clone")" != "$family" ]; then
    family=$(dirname "$clone")
    # Every clone in a family is of the same app; take its name from any
    # finished one.
    app="" exe="" browsers="" installed=""
    for sibling in "$family"/code_sign_clone.*; do
      sibling_bundle=$(clone_bundle "$sibling")
      [ -n "$sibling_bundle" ] || continue
      app=$(basename "$sibling_bundle" .bundle)
      exe=$(plist_value "$sibling_bundle" CFBundleExecutable)
      break
    done
    [ -n "$exe" ] && browsers=$(running_browsers "$app" "$exe")
    for location in "/Applications/$app" "$HOME/Applications/$app"; do
      [ -n "$app" ] && [ -d "$location" ] && installed=$(plist_value "$location" CFBundleShortVersionString) && break
    done
    echo "  $(basename "$family" .code_sign_clone)  (${app:-unknown app} ${installed:-not found} installed)"
  fi

  bundle=$(clone_bundle "$clone")
  born=$(stat -f %B "$clone")
  version=$(plist_value "$bundle" CFBundleShortVersionString)
  kb=$(du -sk "$clone" 2>/dev/null | awk '{ print $1 }')
  kb=${kb:-0}
  owner=""
  while read -r pid start; do
    [ -n "$pid" ] || continue
    if [ "$born" -ge $((start - before_start)) ] && [ "$born" -le $((start + after_start)) ]; then
      owner="${owner:+$owner, }$pid"
    fi
  done <<< "$browsers"

  if [ -n "$owner" ]; then
    status="in use by PID $owner, kept"
  elif [ -z "$bundle" ] || [ -z "$exe" ]; then
    # Being made right now, or of an app this script cannot identify: keep
    # it while it is young enough to belong to a browser that just started.
    if [ $((now - born)) -le "$after_start" ]; then
      status="incomplete, kept"
    else
      status="stranded"
    fi
  else
    status="stranded"
  fi
  if [ "$status" = stranded ]; then
    stranded+=("$clone")
    stranded_kb=$((stranded_kb + kb))
    [ "$version" != "$installed" ] && old_version_kb=$((old_version_kb + kb))
  fi
  printf '    %s  %s  %-14s %8s  %s\n' "$(basename "$clone")" "$(date -r "$born" '+%Y-%m-%d %H:%M')" \
    "${version:-?}" "$(human "$kb")" "$status"
done

echo
if [ ${#stranded[@]} -eq 0 ]; then
  echo "Nothing stranded: every clone belongs to a running browser."
  exit 0
fi
echo "${#stranded[@]} stranded, $(human "$stranded_kb") by du."
echo "du counts each clone in full, but a clone shares its disk blocks with the installed app"
echo "while that version is installed, so it costs real space only after the browser updates."
if [ "$old_version_kb" -gt 0 ]; then
  echo "Some stranded clones are of a version that is no longer installed; those hold real space."
fi

if [ "$clean" -eq 0 ]; then
  echo "Run with --clean to remove the stranded ones."
  exit 0
fi

free_kb() { df -k "$x_dir" | awk 'NR == 2 { print $4 }'; }
before_kb=$(free_kb)
failed=0
for clone in "${stranded[@]}"; do
  # Only ever a clone directory found above, never anything else.
  case "$clone" in "$x_dir"/*.code_sign_clone/code_sign_clone.*) ;; *) continue ;; esac
  if ! rm -rf -- "$clone" 2>/dev/null; then
    chmod -R u+w -- "$clone" 2>/dev/null
    rm -rf -- "$clone" || failed=$((failed + 1))
  fi
done
after_kb=$(free_kb)
echo "Removed $(( ${#stranded[@]} - failed )) of ${#stranded[@]}."
if [ $((after_kb - before_kb)) -ge 102400 ]; then
  echo "About $(human $((after_kb - before_kb))) of disk space came back; $(human "$after_kb") is free."
else
  echo "No measurable disk space came back: the clones shared their blocks with the installed app. $(human "$after_kb") is free."
fi
[ "$failed" -eq 0 ]
