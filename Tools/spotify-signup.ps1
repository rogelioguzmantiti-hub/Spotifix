#Requires -Version 5.1
<#
.SYNOPSIS
    Automatiza el registro de una cuenta de Spotify en un dispositivo/emulador via ADB.

.DESCRIPTION
    Localiza los controles por su texto (no por coordenadas fijas), de modo que
    resiste cambios de layout y funciona en interfaz española o inglesa.
    El paso de fecha de nacimiento se verifica y, si algo no cuadra, ABORTA sin
    enviar: es preferible dejar esa pantalla al usuario que elegir mal su fecha.

.NOTES
    - La contrasena no se guarda en disco ni queda en el historial: se pide de
      forma oculta si se omite el parametro, o llega por la variable de entorno
      SPOTIFY_SIGNUP_PASSWORD desde la GUI.
    - El envio del formulario es optivo (-SubmitSignup) porque el boton
      'Crear cuenta' acepta los Terminos de Uso en tu nombre.
    - Si Spotify responde con un CAPTCHA (challenge.spotify.com) el script se
      detiene y lo deja para el usuario: no lo resuelve ni intenta esquivarlo.
#>
[CmdletBinding()]
param(
    [Parameter()] [ValidateNotNullOrEmpty()] [string] $Email,

    # Si se omite, se solicita de forma oculta.
    [Parameter()] [string] $Password,

    # Opcionales si se usa -RandomAdultBirthday.
    [Parameter()] [int] $BirthMonth,
    [Parameter()] [int] $BirthDay,
    [Parameter()] [int] $BirthYear,

    # Genera una fecha de nacimiento aleatoria con 18+ anos.
    [Parameter()] [switch] $RandomAdultBirthday,

    # Elige una opcion de genero al azar en lugar de preguntar.
    [Parameter()] [switch] $RandomGender,

    [Parameter()] [string] $Serial = 'emulator-5554',

    # Deja el flujo en la pantalla de fecha para que la elijas a mano (3 toques).
    [Parameter()] [switch] $SkipBirthday,

    # Pulsa 'Crear cuenta' y continua con notificaciones y artistas.
    #
    # Es optivo a proposito: ese boton acepta los Terminos de Uso en tu nombre,
    # y automatizarlo en silencio es justo lo que hace un script de alta masiva.
    # Si lo indicas, es porque has leido la pantalla y decides enviarla.
    # El CAPTCHA se sigue resolviendo a mano: esto no lo esquiva.
    [Parameter()] [switch] $SubmitSignup,

    # Artistas a seleccionar en la pantalla de personalizacion.
    #
    # -Artists se buscan por nombre en el buscador. Los que no existan se
    # saltan con aviso, sin cortar el flujo (pasó con 'SB Relax').
    # -MinArtists es el minimo total de tarjetas a pulsar: los nombres explicitos
    # se cuentan primero y el resto se completa con artistas al azar de la
    # rejilla. Pon 0 para solo buscar los nombres indicados.
    #
    # OJO: se cuenta lo que se PULSA, no lo que queda confirmado. La rejilla no
    # expone un estado de seleccion legible por uiautomator, asi que el script
    # no puede verificar la eleccion y lo dice en el log.
    [Parameter()] [string[]] $Artists,

    [Parameter()] [ValidateRange(0, 10)] [int] $MinArtists = 3
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Cuando la salida la recoge otro proceso (la GUI), se fuerza UTF-8 para que los
# acentos no lleguen alterados.
if ($env:SPOTIFY_SIGNUP_GUI -eq '1') {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

    # Write-Host escribe en el stream de informacion, que NO se captura al
    # redirigir stdout: sin esto la GUI no recibiria ninguno de los avisos del
    # script. Se cambia por Write-Output a proposito, perdiendo el color, que en
    # un panel de texto plano no sirve de nada.
    function global:Write-Host {
        param(
            [Parameter(Position = 0, ValueFromPipeline = $true)] $Object,
            [ConsoleColor] $ForegroundColor,
            [ConsoleColor] $BackgroundColor,
            [switch] $NoNewline
        )
        process {
            if ($Object -is [array]) { $Object | ForEach-Object { Write-Output $_ } }
            else { Write-Output $Object }
        }
    }
}

# Abreviaturas de mes por locale (CLDR). Se usan para deducir el orden del ciclo,
# ya que el NumberPicker de mes no se detiene en el minimo: da la vuelta.
$Script:MonthTables = @{
    'es' = 'ene feb mar abr may jun jul ago sept oct nov dic'
    'en' = 'jan feb mar apr may jun jul aug sep oct nov dec'
    'pt' = 'jan fev mar abr mai jun jul ago set out nov dez'
    'it' = 'gen feb mar apr mag giu lug ago set ott nov dic'
    'fr' = 'janv fevr mars avr mai juin juil aout sept oct nov dec'
    'de' = 'jan feb mar apr mai jun jul aug sep okt nov dez'
}

# --------------------------------------------------------------------------
# Capa ADB + uiautomator
# --------------------------------------------------------------------------

function Get-UiNodes {
    for ($i = 0; $i -lt 3; $i++) {
        adb -s $Serial shell uiautomator dump /sdcard/_dump.xml *> $null
        $raw = adb -s $Serial shell cat /sdcard/_dump.xml 2>$null | Out-String
        adb -s $Serial shell rm -f /sdcard/_dump.xml *> $null
        if ($raw -match '<hierarchy') {
            $nodes = foreach ($m in [regex]::Matches($raw, '<node\b[^>]*>')) {
                $n    = $m.Value
                $box  = [regex]::Match($n, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
                if (-not $box.Success) { continue }
                $isPwd = [regex]::Match($n, 'password="([^"]*)"').Groups[1].Value -eq 'true'
                $txt   = [regex]::Match($n, 'text="([^"]*)"').Groups[1].Value
                [pscustomobject]@{
                    Text = if ($isPwd -and $txt) { '<oculto>' } else { $txt }
                    Desc = [regex]::Match($n, 'content-desc="([^"]*)"').Groups[1].Value
                    Cls  = ([regex]::Match($n, 'class="([^"]*)"').Groups[1].Value -split '\.')[-1]
                    Pwd  = $isPwd
                    X    = [int](([int]$box.Groups[1].Value + [int]$box.Groups[3].Value) / 2)
                    Y    = [int](([int]$box.Groups[2].Value + [int]$box.Groups[4].Value) / 2)
                }
            }
            return @($nodes)
        }
    }
    throw 'No se pudo leer la jerarquia de la interfaz.'
}

function Find-Ui {
    param([string] $Pattern, [int] $Tries = 25, [int] $DelayMs = 600, [string] $Cls)

    for ($i = 0; $i -lt $Tries; $i++) {
        # -Cls importa: varias pantallas tienen un TextView con el texto de la
        # accion ('Crear cuenta' aparece como titulo y como boton) y el titulo
        # va antes en el documento, asi que sin filtrar se pulsa el titulo.
        $found = @(Get-UiNodes | Where-Object {
            (($_.Text -match $Pattern) -or ($_.Desc -match $Pattern)) -and
            ([string]::IsNullOrEmpty($Cls) -or ($_.Cls -eq $Cls))
        })
        # No se puede usar @(...)[0] aqui: con cero coincidencias lanza
        # 'indice fuera de los limites' en vez de devolver $null.
        if ($found.Count -gt 0) { return $found[0] }
        Start-Sleep -Milliseconds $DelayMs
    }
    return $null
}

function Invoke-Tap {
    param([int] $X, [int] $Y, [int] $PauseMs = 700)
    adb -s $Serial shell input tap $X $Y *> $null
    Start-Sleep -Milliseconds $PauseMs
}

function Tap-Ui {
    param([string] $Pattern, [string] $What, [string] $Cls)

    # Primero se exige la clase indicada; si no aparece, se reintenta sin
    # filtrar. Asi se evita pulsar el titulo sin que se rompa si el control no
    # resulta ser un Button.
    $node = $null
    if (-not [string]::IsNullOrEmpty($Cls)) {
        $node = Find-Ui -Pattern $Pattern -Cls $Cls -Tries 8 -DelayMs 500
    }
    if (-not $node) { $node = Find-Ui -Pattern $Pattern }

    if (-not $node) { throw "No se encontro el control: $What  (patron: $Pattern)" }
    Write-Host ("  [tap] {0}  en ({1},{2})" -f $What, $node.X, $node.Y)
    Invoke-Tap -X $node.X -Y $node.Y
}

function Type-Ui { param([string] $Value)
    adb -s $Serial shell input text $Value *> $null
    Start-Sleep -Milliseconds 400
}

# --------------------------------------------------------------------------
# NumberPicker: cada toque debe ir precedido de un volcado de UI. Con esperas
# cortas los toques se pierden y la DatePicker reordena (medido: 6 toques
# rapidos movieron el dia de 03 a 27 y desplazaron el mes).
# --------------------------------------------------------------------------

function Read-Col {
    param([int] $ColX)
    $n = @(Get-UiNodes | Where-Object { $_.Cls -eq 'EditText' -and [Math]::Abs($_.X - $ColX) -lt 60 })
    if ($n.Count -eq 0) { throw "Columna del selector en X=$ColX no encontrada." }
    return $n[0].Text
}

# La geometria de las filas no cambia mientras no se rote la pantalla, asi que se
# lee UNA vez y se cachea. Antes se volcaba la UI antes de cada toque, lo que
# costaba ~900 ms por paso (y mas de un minuto en total solo para la fecha).
$Script:PickerGeom       = $null
$Script:PickerTapDelayMs = 260

function Get-PickerGeometry {
    if ($Script:PickerGeom) { return $Script:PickerGeom }

    $nodes  = Get-UiNodes
    $centers = @{}
    foreach ($n in @($nodes | Where-Object { $_.Cls -eq 'EditText' })) {
        $centers[[int]$n.X] = $n.Y
    }
    $buttons = @($nodes | Where-Object { $_.Cls -eq 'Button' -and $_.Text })

    $geom = @{}
    foreach ($colX in $centers.Keys) {
        $cy   = $centers[$colX]
        $near = @($buttons | Where-Object { [Math]::Abs($_.X - $colX) -lt 60 })
        $upMatches   = @($near | Where-Object { $_.Y -lt $cy - 40 } | Sort-Object Y -Descending)
        $downMatches = @($near | Where-Object { $_.Y -gt $cy + 40 } | Sort-Object Y)
        $up   = if ($upMatches.Count   -gt 0) { $upMatches[0] }   else { $null }
        $down = if ($downMatches.Count -gt 0) { $downMatches[0] } else { $null }
        if (-not $up -or -not $down) { throw "Geometria del selector incompleta en X=$colX." }
        $geom[[int]$colX] = [pscustomobject]@{ Center = $cy; Up = $up.Y; Down = $down.Y }
    }
    $Script:PickerGeom = $geom
    return $geom
}

function Step-Col {
    param([int] $ColX, [ValidateSet('Up', 'Down')] [string] $Dir, [int] $Times = 1)

    $geom = Get-PickerGeometry
    $key  = [int]$ColX
    if (-not $geom.ContainsKey($key)) { throw "Geometria del selector desconocida en X=$ColX." }
    $y = if ($Dir -eq 'Up') { $geom[$key].Up } else { $geom[$key].Down }

    for ($i = 0; $i -lt $Times; $i++) {
        adb -s $Serial shell input tap $key $y *> $null
        Start-Sleep -Milliseconds $Script:PickerTapDelayMs
    }
}

function Get-Cycle {
    <# Recorre el ciclo completo de una columna y devuelve los valores en orden. #>
    param([int] $ColX, [int] $MaxSteps = 40)

    $seq = @((Read-Col -ColX $ColX))
    for ($i = 0; $i -lt $MaxSteps; $i++) {
        Step-Col -ColX $ColX -Dir Up -Times 1
        $v = Read-Col -ColX $ColX
        if ($v -eq $seq[0]) { return , $seq }
        $seq += $v
    }
    throw "El ciclo en X=$ColX no se cerro en $MaxSteps pasos (ciclo=[$($seq -join ',')])."
}

function Norm-Month {
    <# Quita diacriticos y todo lo que no sea letra. Importante: si solo se
       filtrase por [^A-Za-z], 'fevr.' se volveria 'fvr' y no casaria nunca con
       la tabla ('fev'). #>
    param([string] $Text)
    $decomposed = $Text.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $decomposed.ToCharArray()) {
        $code = [int]$c
        if ($code -lt 0x0300 -or $code -gt 0x036F) { $null = $sb.Append($c) }
    }
    return ($sb.ToString() -replace '[^A-Za-z]', '').ToLower()
}

function Resolve-MonthCycle {
    <#
    Get-Cycle recorre con 'Up', asi que el ciclo sale en orden DESCENDENTE
    (nov, oct, ... ene, dic, y vuelta a nov). Por eso se compara contra la tabla
    invertida y se busca la ROTACION que encaja: el resultado es el numero de
    mes de cada posicion del ciclo.
    #>
    param([string[]] $Cycle)

    $n = $Cycle.Count
    foreach ($loc in $Script:MonthTables.Keys) {
        $asc = $Script:MonthTables[$loc] -split ' '
        if ($asc.Count -ne $n) { continue }

        $desc = @($asc[($n - 1)..0])        # indice 0 => mes 12, indice n-1 => mes 1
        foreach ($r in 0..($n - 1)) {
            $ok = $true
            for ($i = 0; $i -lt $n; $i++) {
                $a = Norm-Month $Cycle[$i]
                $b = Norm-Month $desc[($i + $r) % $n]
                if ($a -ne $b -and -not $a.StartsWith($b) -and -not $b.StartsWith($a)) { $ok = $false; break }
            }
            if ($ok) {
                $months = @(for ($i = 0; $i -lt $n; $i++) { $n - (($i + $r) % $n) })
                Write-Host ("  [picker] locale '{0}', rotacion {1} -> mes actual {2}" -f $loc, $r, $months[0]) -ForegroundColor DarkGray
                return , $months
            }
        }
    }
    throw "No se reconoce el locale del selector de mes (ciclo=[$($Cycle -join ',')]). Anade el locale a `$Script:MonthTables."
}

function Get-MonthNumber {
    <# Deduce el numero de mes de UNA abreviatura, sin recorrer el ciclo.
       Varias tablas pueden contener la misma abreviatura, pero si todas
       coinciden en el numero no hay ambiguedad ('sept' -> 9 en es y fr, etc.).
       Devuelve el numero, o $null si no casa o si las tablas discrepan. #>
    param([string] $Text)

    $norm = Norm-Month $Text
    if (-not $norm) { return $null }

    $found = @()
    foreach ($loc in $Script:MonthTables.Keys) {
        $asc = $Script:MonthTables[$loc] -split ' '
        for ($i = 0; $i -lt $asc.Count; $i++) {
            $b = Norm-Month $asc[$i]
            if ($norm -eq $b -or $norm.StartsWith($b) -or $b.StartsWith($norm)) {
                $found += ($i + 1)
                break
            }
        }
    }
    $uniq = @($found | Sort-Object -Unique)
    if ($uniq.Count -eq 1) { return [int]$uniq[0] }
    return $null
}

function Set-MonthColumn {
    param([int] $ColX, [int] $Target)

    $cur          = Read-Col -ColX $ColX
    $currentMonth = Get-MonthNumber -Text $cur

    if ($null -ne $currentMonth) {
        Write-Host ("  [picker] mes '$cur' = $currentMonth -> objetivo $Target")
    }
    else {
        # Sin coincidencia o con discrepancia entre tablas: se recorre el ciclo
        # (lento, pero infalible) y se identifica el locale por la rotacion.
        Write-Warning "  abreviatura '$cur' desconocida o ambigua; recorriendo el ciclo"
        $cycle  = Get-Cycle -ColX $ColX
        if ($cycle.Count -ne 12) { throw "La columna de mes tiene $($cycle.Count) valores, no 12: [$($cycle -join ',')]." }
        $currentMonth = (Resolve-MonthCycle -Cycle $cycle)[0]
    }

    # 'Down' suma un mes y da la vuelta al pasar por diciembre.
    $steps = ($Target - $currentMonth + 12) % 12
    Write-Host ("  [picker] $steps pasos hacia abajo")
    if ($steps -gt 0) { Step-Col -ColX $ColX -Dir Down -Times $steps }

    $afterNum = Get-MonthNumber -Text (Read-Col -ColX $ColX)
    if ($afterNum -eq $Target) { return $true }
    Write-Warning "  el mes quedo en '$afterNum', no en $Target"
    return $false
}

function Set-YearColumn {
    param([int] $ColX, [int] $Target)

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $curText = Read-Col -ColX $ColX
        $cur = 0
        if (-not [int]::TryParse($curText, [ref]$cur)) { throw "Anio no numerico: '$curText'" }
        if ($cur -eq $Target) { return }

        $delta = $Target - $cur
        Write-Host ("  [picker] anio $cur -> $Target ($delta pasos, intento $attempt)")
        if ($delta -gt 0) { Step-Col -ColX $ColX -Dir Down -Times  $delta }
        else             { Step-Col -ColX $ColX -Dir Up   -Times (-$delta) }

        $after = Read-Col -ColX $ColX
        if ($after -eq $Target) { return $true }
        Write-Warning "  el anio quedo en '$after' (rango del picker limitado?), reintentando"
    }
    Write-Warning "  el anio no se pudo fijar en $Target"
    return $false
}

function Set-DayColumn {
    <# El dia no se detiene en 01: salta al ultimo dia del mes anterior, y al
       bajar de 31 pasa al 01 del mes SIGUIENTE. Por eso la direccion se elige
       para no cruzar nunca el limite del mes y poder calcular los pasos de una
       vez, en vez de avanzar comparando paso a paso. #>
    param([int] $ColX, [int] $Target, [int] $Year, [int] $Month)

    $maxDay = [DateTime]::DaysInMonth($Year, $Month)
    $effective = if ($Target -gt $maxDay) {
        Write-Warning "  el dia $Target no existe en $Year-$Month; se usa $maxDay"
        $maxDay
    } else { $Target }

    $curText = Read-Col -ColX $ColX
    $cur = 0
    if (-not [int]::TryParse($curText, [ref]$cur)) { throw "Dia no numerico: '$curText'" }
    if ($cur -lt 1 -or $cur -gt $maxDay) { throw "Dia actual fuera de rango para ${Year}-${Month}: $cur" }

    if ($cur -eq $effective) { Write-Host "  [picker] dia ya es $cur"; return $true }

    $dir   = if ($effective -gt $cur) { 'Down' } else { 'Up' }
    $steps = [Math]::Abs($effective - $cur)
    Write-Host ("  [picker] dia $cur -> $effective ($steps pasos hacia $dir)")
    Step-Col -ColX $ColX -Dir $dir -Times $steps

    $after = Read-Col -ColX $ColX
    $n = 0
    if ([int]::TryParse($after, [ref]$n) -and $n -eq $effective) { return $true }
    Write-Warning "  el dia quedo en '$after', no en $effective"
    return $false
}

function Set-DatePicker {
    <#
    La DatePicker renormaliza la fecha al cambiar un campo, asi que ajustar uno
    puede mover otro: se ha medido como al bajar el mes el anio se iba +1.
    Por eso se ajustan los tres y se comprueban los tres juntos, repitiendo
    hasta que el TRIPLE coincida. Devuelve $true solo si convergio.
    #>
    param([int] $DayColX, [int] $MonColX, [int] $YearColX,
          [int] $Day, [int] $Month, [int] $Year, [int] $MaxPasses = 3)

    for ($pass = 1; $pass -le $MaxPasses; $pass++) {
        $null = Set-YearColumn -ColX $YearColX -Target $Year
        $null = Set-MonthColumn -ColX $MonColX -Target $Month
        $null = Set-DayColumn  -ColX $DayColX  -Target $Day -Year $Year -Month $Month

        $d = Read-Col -ColX $DayColX
        $dNum = 0
        $null = [int]::TryParse($d, [ref]$dNum)   # la UI puede devolver '01', no '1'
        $m = Get-MonthNumber -Text (Read-Col -ColX $MonColX)
        $y = Read-Col -ColX $YearColX
        Write-Host ("  [picker] verificacion pasada {0}: dia={1} mes={2} anio={3}" -f $pass, $d, $m, $y) -ForegroundColor DarkGray

        if ($dNum -eq $Day -and $m -eq $Month -and $y -eq "$Year") { return $true }

        Write-Warning "  la DatePicker movio un campo; corrigiendo (pasada $pass)"
        $Script:PickerGeom = $null   # por si el layout se ha reordenado
    }
    return $false
}

# --------------------------------------------------------------------------
# Pantalla de artistas
#
# La rejilla son TextView, no botones, y el campo de busqueda esta encima. Por eso
# se filtra por clase y por posicion: sin el filtro entran los titulos de la
# cabecera y el propio buscador.
# --------------------------------------------------------------------------

function Get-ArtistGrid {
    <#
    Artistas visibles en la rejilla, con su coordenada de toque.

    Acepta -Nodes para reutilizar un volcado ya hecho por el llamante: aqui cada
    llamada cuesta 1-2 s de 'uiautomator dump' y el bucle principal ya tiene uno.

    El 'return' NO lleva coma delante. Con 'return , @($out)' y $out vacio, el
    pipeline entrega un unico elemento (un array vacio) en vez de cero, y el
    Where-Object del llamante acaba haciendo $_.Text sobre un array vacio:
    'No se encuentra la propiedad Text en este objeto'.
    #>
    param([object[]] $Nodes)

    if (-not $Nodes) { $Nodes = Get-UiNodes }

    # Limite superior de la rejilla. Medido: cabecera en Y=236, boton 'Buscar' en
    # Y=532 y primera fila de artistas en Y=1046. El campo de texto NO cuenta
    # porque en la rejilla no hay ninguno: aparece al pulsar 'Buscar'.
    $top = 900
    $btn = @($Nodes | Where-Object { $_.Cls -eq 'Button' -and $_.Text -match '^(Buscar|Search)$' } |
             Select-Object -First 1)
    if ($btn.Count -gt 0) { $top = $btn[0].Y + 200 }
    else {
        $campo = @($Nodes | Where-Object { $_.Cls -eq 'EditText' } | Select-Object -First 1)
        if ($campo.Count -gt 0) { $top = $campo[0].Y + 120 }
    }

    # La cabecera 'Elige 3 o más artistas que te gusten.' NO es un artista. El
    # '^(...)$' de antes no la excluia porque es una frase entera, no la palabra
    # suelta: ahora el filtro va contra la cabecera de forma explicita.
    $ruido = '^(Buscar|Search|Elige .*|Elige|Elegir.*|Elegir|Pick.*|Tus artistas|Who you like|' +
             'Saltar|Skip|Ahora no|Now,? no|No thanks|De acuerdo|Hecho|Done|Listo|' +
             'Confirmar|Finish|Siguiente|Next|Continuar|Continue|Omitir)$'

    $out = @()
    foreach ($n in $Nodes) {
        if ($n.Cls -ne 'TextView' -or [string]::IsNullOrWhiteSpace($n.Text)) { continue }
        if ($n.Text -match $ruido) { continue }
        if ($n.Y -lt $top) { continue }
        $out += $n
    }
    return @($out)
}

function Back-ToGrid {
    <# KEYCODE_BACK devuelve de los resultados del buscador a la rejilla. A veces
       hay que pulsarlo dos veces, asi que se comprueba y se reintenta. #>
    adb -s $Serial shell input keyevent KEYCODE_BACK *> $null
    Start-Sleep -Seconds 2
    if (@(Get-ArtistGrid).Count -eq 0) {
        adb -s $Serial shell input keyevent KEYCODE_BACK *> $null
        Start-Sleep -Seconds 2
    }
}

function Enter-Search {
    <#
    Abre el buscador de la pantalla de artistas.

    Imprescindible: en la rejilla NO hay ningun EditText, solo un Button
    'Buscar' (medido en (181,532)). El campo de texto aparece al pulsarlo. Sin
    este paso Select-ArtistBySearch no encuentra campo y omite todos los
    artistas, que es justo lo que pasaba.
    #>
    $btn = @(Get-UiNodes | Where-Object {
        $_.Cls -eq 'Button' -and $_.Text -match '^(Buscar|Search)$'
    } | Select-Object -First 1)

    if ($btn.Count -gt 0) {
        Write-Host ("  [artistas] abriendo el buscador ('{0}' en ({1},{2}))" -f $btn[0].Text, $btn[0].X, $btn[0].Y)
        Invoke-Tap -X $btn[0].X -Y $btn[0].Y -PauseMs 2000
    }

    # El EditText puede tardar en aparecer tras la animacion.
    for ($i = 0; $i -lt 5; $i++) {
        $campo = @(Get-UiNodes | Where-Object { $_.Cls -eq 'EditText' } | Select-Object -First 1)
        if ($campo.Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 800
    }

    Write-Warning '  el buscador se abrio pero no aparece el campo de texto'
    return $false
}

function Select-ArtistBySearch {
    <# Busca un artista por nombre y pulsa su resultado. Devuelve $true si lo
       encontro. No lanza excepcion si no aparece: es un resultado normal. #>
    param([string] $Name)

    if (-not (Enter-Search)) { return $false }

    $campo = @(Get-UiNodes | Where-Object { $_.Cls -eq 'EditText' } | Select-Object -First 1)
    if ($campo.Count -eq 0) {
        Write-Warning "  no hay campo de busqueda; no se busca '$Name'"
        return $false
    }

    Invoke-Tap -X $campo[0].X -Y $campo[0].Y -PauseMs 600

    # 'input text' necesita los espacios como %s
    adb -s $Serial shell input text ($Name -replace ' ', '%s') *> $null
    Start-Sleep -Seconds 3

    # Se excluye el propio EditText (contiene lo tecleado) y todo lo que este
    # por encima del campo: si no, la busqueda 'encuentra' el texto introducido.
    $limite = $campo[0].Y
    $hit = @(Get-UiNodes | Where-Object {
        $_.Cls -ne 'EditText' -and
        $_.Y -gt $limite -and
        $_.Text -and
        $_.Text.Trim() -like "*$($Name.Trim())*"
    } | Select-Object -First 1)

    if ($hit.Count -eq 0) {
        Write-Warning "  no hay resultados para '$Name'"
        return $false
    }

    Write-Host ("  [artistas] busqueda '{0}' -> pulsa '{1}' en ({2},{3})" -f `
        $Name, $hit[0].Text, $hit[0].X, $hit[0].Y)
    Invoke-Tap -X $hit[0].X -Y $hit[0].Y -PauseMs 1800
    return $true
}

function Select-RandomArtists {
    <# Pulsa artistas al azar de la rejilla hasta llegar a $Target, evitando
       repetir los ya pulsados y los indicados por nombre. #>
    param([int] $Target, [string[]] $Exclude = @(), [object[]] $Nodes)

    $picked = @()
    for ($i = 0; $i -lt $Target; $i++) {
        $grid = @(Get-ArtistGrid -Nodes $Nodes | Where-Object {
            $Exclude -notcontains $_.Text -and $picked -notcontains $_.Text
        })
        if ($grid.Count -eq 0) {
            Write-Warning '  no quedan artistas visibles en la rejilla'
            break
        }
        $c = $grid[[System.Random]::new().Next(0, $grid.Count)]
        $picked += $c.Text
        Invoke-Tap -X $c.X -Y $c.Y -PauseMs 1500
        Write-Host ("  [artistas] {0}/{1} '{2}' en ({3},{4})" -f `
            ($i + 1), $Target, $c.Text, $c.X, $c.Y)
    }
    return , $picked
}

function Invoke-ArtistSelection {
    <# Primero busca los nombres indicados; despues completa hasta $Min con
       artistas al azar. Devuelve los nombres pulsados. #>
    param([string[]] $Names, [int] $Min)

    Write-Host "`n== Seleccion de artistas ==" -ForegroundColor Cyan
    $hechos = @()

    foreach ($n in @($Names)) {
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        if (Select-ArtistBySearch -Name $n) {
            $hechos += $n.Trim()
        }
        else {
            # No existe o no salia en resultados: se avisa y se sigue. Antes de
            # 'Crear cuenta' solo habria advertencia; aqui se dice cual fallo.
            Write-Warning "  omitido: '$n'"
        }
        Back-ToGrid
    }

    $faltan = $Min - $hechos.Count
    if ($faltan -gt 0) {
        Write-Host ("  faltan {0} para el minimo de {1}: se completa al azar" -f $faltan, $Min)
        $hechos += @(Select-RandomArtists -Target $faltan -Exclude $hechos)
    }

    Write-Host ("  pulsados: {0} de {1} pedidos -> {2}" -f `
        $hechos.Count, $Min, ($hechos -join ', ')) -ForegroundColor DarkGray

    if ($hechos.Count -lt $Min) {
        # El ${Min} lleva llaves porque '$Min:' se interpretaria como un
        # intento de acceso con ambito y es un error de sintaxis.
        Write-Warning "  solo se pulsaron $($hechos.Count) de los ${Min}: revisa la pantalla a mano"
    }
    return , $hechos
}

# --------------------------------------------------------------------------
# Flujo
# --------------------------------------------------------------------------

try {
    $state = (adb -s $Serial get-state 2>$null | Out-String).Trim()
    if ($state -ne 'device') { throw "Dispositivo '$Serial' no disponible (estado: '$state')." }

    # Si falta el correo se pregunta de forma visible. Antes era un parametro
    # Mandatory, y el prompt automatico de PowerShell es ilegible (ademas
    # aparecia DESPUES de arrancar la consola, lo que parece un cuelgue).
    if ([string]::IsNullOrWhiteSpace($Email)) {
        Write-Host 'No se indico -Email.' -ForegroundColor Yellow
        $Email = (Read-Host 'Correo de Spotify').Trim()
    }
    if ([string]::IsNullOrWhiteSpace($Email) -or $Email -notmatch '^[^@\s]+@[^@\s]+$') {
        throw "Correo invalido o vacio: '$Email'"
    }

    if (-not $PSBoundParameters.ContainsKey('Password') -and [string]::IsNullOrEmpty($Password)) {
        # La GUI pasa la contrasena por variable de entorno, no por linea de
        # comandos: en la linea de comandos queda visible para cualquier proceso
        # del sistema, y ademas PowerShell la escribiria en su propio historial.
        $Password = $env:SPOTIFY_SIGNUP_PASSWORD
    }

    if (-not $PSBoundParameters.ContainsKey('Password') -and [string]::IsNullOrEmpty($Password)) {
        # -AsSecureString no hace eco de nada: sin este aviso el usuario cree
        # que la consola se ha quedado colgada.
        Write-Host 'Escribe la contrasena y pulsa Enter (no se mostrara nada mientras escribes).' -ForegroundColor DarkGray
        $secure   = Read-Host 'Contrasena de Spotify' -AsSecureString
        $Password = [System.Net.NetworkCredential]::new('', $secure).Password
    }
    if ([string]::IsNullOrEmpty($Password)) { throw 'Contrasena vacia: no se escribio nada. Vuelve a lanzarlo.' }
    $env:SPOTIFY_SIGNUP_PASSWORD = $null
    if ($Password.Length -lt 10) { Write-Warning "Spotify exige 10+ caracteres; esta tiene $($Password.Length)." }

    if ($RandomAdultBirthday) {
        $rng       = [System.Random]::new()
        $BirthYear = $rng.Next(1985, 2003)
        $BirthMonth = $rng.Next(1, 13)
        $BirthDay  = $rng.Next(1, [DateTime]::DaysInMonth($BirthYear, $BirthMonth) + 1)
        Write-Host ("Fecha generada: {0}/{1}/{2}  ({3} anos)" -f `
            $BirthDay, $BirthMonth, $BirthYear, (2026 - $BirthYear)) -ForegroundColor DarkGray
    }
    elseif (-not ($BirthDay -and $BirthMonth -and $BirthYear)) {
        throw 'Indica -BirthDay, -BirthMonth y -BirthYear, o bien -RandomAdultBirthday.'
    }
    if ($BirthMonth -lt 1 -or $BirthMonth -gt 12) { throw "Mes invalido: $BirthMonth" }
    if ($BirthDay -lt 1 -or $BirthDay -gt 31)     { throw "Dia invalido: $BirthDay" }
    if ($BirthYear -lt 1900 -or $BirthYear -gt 2020) { throw "Anio invalido: $BirthYear" }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    Write-Host "`n== Reiniciando Spotify ==" -ForegroundColor Cyan
    adb -s $Serial shell am force-stop com.spotify.music *> $null
    Start-Sleep -Milliseconds 800

    # Se usa 'am start' y no 'monkey': monkey escribe una linea de diagnostico en
    # stderr que, con ErrorActionPreference='Stop', aborta el script en PS 5.1.
    $resolved = adb -s $Serial shell cmd package resolve-activity --brief `
                                -c android.intent.category.LAUNCHER com.spotify.music 2>$null |
                 Select-Object -Last 1 | Out-String
    $component = if ($resolved.Trim() -match '^[\w.]+/[\w.]+$') { $resolved.Trim() }
                 else { 'com.spotify.music/.MainActivity' }
    Write-Host "  [launch] $component" -ForegroundColor DarkGray
    adb -s $Serial shell am start -n $component *> $null
    Start-Sleep -Seconds 6

    Write-Host "`n== 1. Pantalla de acceso ==" -ForegroundColor Cyan
    Tap-Ui -Pattern '^(Registrarte gratis|Sign up free)$' -What 'Registrarse gratis'

    Write-Host "`n== 2. Metodo de contacto ==" -ForegroundColor Cyan
    Tap-Ui -Pattern '^(Continuar con correo|Continue with email|Sign up with email)$' -What 'Continuar con correo'

    Write-Host "`n== 3. Correo ==" -ForegroundColor Cyan
    $edit = @(Get-UiNodes | Where-Object { $_.Cls -eq 'EditText' -and -not $_.Pwd })
    if ($edit.Count -eq 0) { throw 'Campo de correo no encontrado.' }
    Invoke-Tap -X $edit[0].X -Y $edit[0].Y
    Type-Ui -Value $Email
    Tap-Ui -Pattern '^(Siguiente|Next|Continuar|Continue)$' -What 'Siguiente (correo)'

    Write-Host "`n== 4. Contrasena ==" -ForegroundColor Cyan
    $pw = @(Get-UiNodes | Where-Object { $_.Cls -eq 'EditText' -and $_.Pwd })
    if ($pw.Count -eq 0) { throw 'Campo de contrasena no encontrado.' }
    Invoke-Tap -X $pw[0].X -Y $pw[0].Y
    Type-Ui -Value $Password
    Tap-Ui -Pattern '^(Siguiente|Next|Continuar|Continue)$' -What 'Siguiente (contrasena)'

    Write-Host "`n== 5. Fecha de nacimiento ==" -ForegroundColor Cyan
    if (-not (Find-Ui -Pattern 'fecha de nacimiento|birthday|date of birth')) {
        throw 'No aparecio la pantalla de fecha de nacimiento.'
    }

    if ($SkipBirthday) {
        Write-Host '  -SkipBirthday: se detiene aqui. Elige la fecha a mano y pulsa Siguiente.' -ForegroundColor Yellow
        return
    }

    # El anio es la unica columna con 4 digitos.
    $cols     = @(Get-UiNodes | Where-Object { $_.Cls -eq 'EditText' })
    $yearCol  = $cols | Where-Object { $_.Text -match '^\d{4}$' } | Select-Object -First 1
    if (-not $yearCol) { throw 'No se identifico la columna de anio.' }
    $others = @($cols | Where-Object { $_ -ne $yearCol } | Sort-Object X)
    if ($others.Count -lt 2) { throw 'No se identificaron las columnas de dia y mes.' }
    $dayCol = $others[0]
    $monCol = $others[1]
    Write-Host ("  [picker] dia X={0}, mes X={1}, anio X={2}" -f $dayCol.X, $monCol.X, $yearCol.X)

    # Se ajustan los tres campos juntos y se comprueban los tres: cambiar uno
    # puede mover otro (ver Set-DatePicker).
    $ok = Set-DatePicker -DayColX $dayCol.X -MonColX $monCol.X -YearColX $yearCol.X `
                          -Day $BirthDay -Month $BirthMonth -Year $BirthYear

    $final = @{
        Dia  = Read-Col -ColX $dayCol.X
        Mes  = Get-MonthNumber -Text (Read-Col -ColX $monCol.X)
        Anio = Read-Col -ColX $yearCol.X
    }
    $finalDia = 0
    $null = [int]::TryParse($final.Dia, [ref]$finalDia)
    Write-Host ("  [picker] final -> dia {0}, mes {1}, anio {2}" -f $final.Dia, $final.Mes, $final.Anio) -ForegroundColor DarkGray

    # No se envia nunca una fecha sin confirmar: es preferible que el usuario
    # la elija a mano que registrarle una fecha equivocada.
    if (-not $ok -or $final.Anio -ne "$BirthYear" -or $final.Mes -ne $BirthMonth -or $finalDia -ne $BirthDay) {
        throw "La fecha no se pudo confirmar (quedo dia $($final.Dia)/mes $($final.Mes)/anio $($final.Anio); se pedia $BirthDay/$BirthMonth/$BirthYear). NO se ha enviado: corrige la fecha a mano y pulsa Siguiente."
    }

    Tap-Ui -Pattern '^(Siguiente|Next|Continuar|Continue)$' -What 'Siguiente (fecha)'

    Write-Host "`n== 6. Genero ==" -ForegroundColor Cyan
    if (Find-Ui -Pattern 'g[eé]nero|gender') {
        if ($RandomGender) {
            # Solo se pulsan los botones de opcion: se descartan 'Siguiente' y
            # cualquier otro control de la pantalla.
            $skip    = '^(Siguiente|Next|Continuar|Continue|Omitir|Skip)$'
            $options = @(Get-UiNodes | Where-Object {
                $_.Cls -eq 'Button' -and $_.Text -and $_.Text -notmatch $skip
            })
            if ($options.Count -eq 0) { throw 'No se encontraron opciones de genero.' }
            $chosen = $options[[System.Random]::new().Next(0, $options.Count)]
            Write-Host ("  [genero] eligiendo al azar entre {0}: '{1}'" -f $options.Count, $chosen.Text)
            Invoke-Tap -X $chosen.X -Y $chosen.Y -PauseMs 1500

            # Aqui hay que ser corto a proposito. Si la pantalla de genero no
            # tiene 'Siguiente' (el flujo puede saltar solo a la del nombre),
            # buscarlo con los 25 intentos por defecto costaba ~50 s de volteo
            # de interfaz antes de ni siquiera acercarse a 'Crear cuenta'.
            $next = Find-Ui -Pattern '^(Siguiente|Next|Continuar|Continue)$' -Tries 3 -DelayMs 300 -Cls 'Button'
            if ($next) {
                Write-Host ("  [genero] pulsando '{0}'" -f $next.Text)
                Invoke-Tap -X $next.X -Y $next.Y
            }
            else {
                Write-Host '  [genero] sin boton Siguiente: la pantalla avanza sola'
            }
        }
        else {
            Write-Host '  -RandomGender no indicado: se detiene en la pantalla de genero.' -ForegroundColor Yellow
            return
        }
    }

    # ---- Envio del formulario --------------------------------------------
    if (-not $SubmitSignup) {
        Write-Host "`n== Estado final (intervencion manual) ==" -ForegroundColor Cyan
        Write-Host 'No se ha enviado nada: falta -SubmitSignup.' -ForegroundColor Yellow
        Write-Host @"
El boton 'Crear cuenta' acepta los Terminos de Uso en tu nombre, asi que el
script no lo pulsa salvo que lo pidas explicitamente con -SubmitSignup.
"@ -ForegroundColor Yellow
        return
    }

    Write-Host "`n== 7. Envio del formulario ==" -ForegroundColor Cyan
    # -Cls 'Button' es imprescindible: el titulo de la pantalla tambien pone
    # 'Crear cuenta' y sin esto se pulsa el titulo (y no ocurre nada).
    Tap-Ui -Pattern '^(Crear cuenta|Create account|Sign up)$' -What 'Crear cuenta' -Cls 'Button'

    # ---- Avisos y pantallas posteriores ------------------------------------
    # El orden real no es fijo: segun la cuenta, tras 'Crear cuenta' puede venir
    # el aviso de notificaciones, el CAPTCHA o los artistas. Se comprueba una
    # sola vez por vuelta contra un unico volcado de la jerarquia: hacer cuatro
    # Find-Ui seguidos costaba cuatro 'uiautomator dump' y hacia que el paso
    # pareciese colgado.
    $reCaptcha = 'challenge\.spotify\.com|recaptcha|hcaptcha'
    $pAtras    = '^(Más tarde|Mas tarde|Not now|Later|Omitir)$'
    # El dialogo de artistas que ofrece 'Saltar' / 'Elegir artistas' es una
    # pantalla DISTINTA de la rejilla: aqui se elige como entrar o como saltarla.
    $pSaltar   = '^(Saltar|Skip)$'
    $pElegir   = '^(Elegir artistas|Choose artists|Elegir|Choose)$'
    $pAhoraNo  = '^(Ahora no|Now,? no|No thanks|De acuerdo)$'
    $pHecho    = '^(Hecho|Done|Listo|Confirmar|Finish)$'
    $pBuscar   = '^(Buscar|Search)$'

    # Ojo con esto: @($null).Count devuelve 1, no 0, en PowerShell. Comprobar
    # la lista con @($Artists).Count haria que el filtro pareciesesiempre cheio.
    $hayLista = ($null -ne $Artists) -and (@($Artists).Count -gt 0)
    $queremosArtistas = $hayLista -or $MinArtists -gt 0
    $artistasListos = $false

    for ($i = 0; $i -lt 10; $i++) {
        $nodes   = Get-UiNodes
        $botones = @($nodes | Where-Object { $_.Cls -eq 'Button' })

        if (@($nodes | Where-Object { ($_.Text -match $reCaptcha) -or ($_.Desc -match $reCaptcha) }).Count -gt 0) {
            Write-Host "`n== CAPTCHA (auto-solve CapSolver) ==" -ForegroundColor Yellow
            try {
                $solverPy = Join-Path (Split-Path -Parent $PSCommandPath) 'capsolver_spotify.py'
                $env:SPOTIFIX_ADB = 'adb'
                & python $solverPy $Serial 2>&1 | ForEach-Object { Write-Host ("  [capsolver] " + $_) }
                if ($LASTEXITCODE -eq 0) {
                    Write-Host '  [capsolver] token inyectado, esperando 10s y reevaluando...' -ForegroundColor Green
                    Start-Sleep -Seconds 10
                    continue
                } else {
                    Write-Warning ("  [capsolver] fallo (exit " + $LASTEXITCODE + "), se deriva a espera manual")
                }
            } catch {
                Write-Warning ("  [capsolver] error: " + $_.Exception.Message)
            }
            Write-Host "`n== CAPTCHA ==" -ForegroundColor Yellow
            Write-Host @"
El formulario se ha enviado y Spotify pide verificacion humana
(challenge.spotify.com). Eso lo haces tu.

El script se detiene aqui: no resuelve el reto ni intenta esquivarlo. Es un
control antiautomacion, y esquivarlo es justo lo que permitiria dar de alta
cientos de cuentas sin que nadie las haya creado a mano.
"@ -ForegroundColor Yellow
            Write-Host ("  transcurrido: {0:n1} s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
            return
        }

        # --- Dialogo 'Saltar' / 'Elegir artistas' ---------------------------
        # Es una pantalla aparte, no la rejilla: solo tiene dos botones y ningun
        # campo de busqueda. Antes se confundia con la rejilla y la seleccion
        # fallaba sin que hubiera nada que elegir todavia.
        $hitSaltar = @($botones | Where-Object { $_.Text -match $pSaltar }) | Select-Object -First 1
        $hitElegir = @($botones | Where-Object { $_.Text -match $pElegir }) | Select-Object -First 1

        if ($hitElegir -and $queremosArtistas -and -not $artistasListos) {
            Write-Host ("  [artistas] entrando en la pantalla de eleccion ('{0}')" -f $hitElegir.Text)
            Invoke-Tap -X $hitElegir.X -Y $hitElegir.Y -PauseMs 2500
            continue
        }

        if ($hitSaltar) {
            if ($queremosArtistas) {
                Write-Warning "  solo se ofrece Saltar y no hay rejilla: no se pueden elegir artistas"
                $artistasListos = $true
            }
            else {
                Write-Host ("  [artistas] pulsando '{0}'" -f $hitSaltar.Text)
                Invoke-Tap -X $hitSaltar.X -Y $hitSaltar.Y -PauseMs 2500
                continue
            }
        }

        # --- Rejilla real ---------------------------------------------------
        # NO se puede exigir un EditText para reconocerla: en la rejilla no hay
        # ninguno, el buscador es un Button. Se reconoce por la cabecera
        # ('Elige 3 o más artistas que te gusten.') mas una rejilla con varios
        # candidatos, que es lo unico que no puede ser otra pantalla.
        $rejilla   = @(Get-ArtistGrid -Nodes $nodes)
        $cabecera  = @($nodes | Where-Object { $_.Text -match 'Elige .*artistas|tus artistas|Who you like' }).Count -gt 0
        $hayBuscar = @($botones | Where-Object { $_.Text -match $pBuscar }).Count -gt 0
        # Tras abrir el buscador el campo de texto si aparece; se acepta como
        # senal secundaria de que estamos en la rejilla.
        $hayCampo  = @($nodes | Where-Object { $_.Cls -eq 'EditText' }).Count -gt 0
        $esRejilla = $rejilla.Count -ge 3 -and ($cabecera -or $hayBuscar -or $hayCampo)

        if ($esRejilla -and -not $artistasListos -and $queremosArtistas) {
            $null = Invoke-ArtistSelection -Names $Artists -Min $MinArtists
            $artistasListos = $true
            continue
        }

        # Si hay candidatos pero no se reconoce la cabecera y no queda otro camino,
        # se avisa en vez de declarar 'Terminado' en silencio.
        if ($rejilla.Count -ge 3 -and -not $artistasListos) {
            Write-Warning ("  {0} artistas visibles pero no se reconoce la pantalla de artistas; no se tocan" -f $rejilla.Count)
            $artistasListos = $true
            continue
        }

        $hit = @($botones | Where-Object { $_.Text -match $pAtras }) | Select-Object -First 1
        if ($hit) {
            Write-Host ("  [aviso] descartando '{0}' en ({1},{2})" -f $hit.Text, $hit.X, $hit.Y)
            Invoke-Tap -X $hit.X -Y $hit.Y -PauseMs 2000
            continue
        }

        $hit = @($botones | Where-Object { $_.Text -match $pAhoraNo }) | Select-Object -First 1
        if ($hit) {
            Write-Host ("  [artistas] omitiendo la personalizacion ('{0}')" -f $hit.Text)
            Invoke-Tap -X $hit.X -Y $hit.Y -PauseMs 2500
            continue
        }

        $hit = @($botones | Where-Object { $_.Text -match $pHecho }) | Select-Object -First 1
        if ($hit) {
            Write-Host ("  [artistas] cerrando la seleccion ('{0}')" -f $hit.Text)
            Invoke-Tap -X $hit.X -Y $hit.Y -PauseMs 2000
            continue
        }

        # Ninguna de las pantallas conocidas: se comprueba una vez mas por si
        # la pantalla aun esta transitioning y se da por terminado.
        Start-Sleep -Seconds 2
        $recheck = Get-UiNodes
        if (@($recheck | Where-Object { $_.Cls -eq 'Button' -and
                ($_.Text -match $pAtras -or $_.Text -match $pAhoraNo -or $_.Text -match $pHecho -or
                 $_.Text -match $pSaltar -or $_.Text -match $pElegir) }).Count -eq 0) {
            Write-Host "`n== Terminado ==" -ForegroundColor Cyan
            Write-Host 'Sin CAPTCHA ni pantallas pendientes. Revisa el movil.' -ForegroundColor Yellow
            Write-Host ("  transcurrido: {0:n1} s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
            $recheck | Where-Object { $_.Text } | Select-Object -First 25 X, Y, Cls, Text | Format-Table -AutoSize
            return
        }
    }

    Write-Host "`n== Se agotaron los intentos ==" -ForegroundColor Yellow
    Write-Host 'Queda alguna pantalla sin reconocer. Revisa el movil a mano.' -ForegroundColor Yellow
    Write-Host ("  transcurrido: {0:n1} s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
}
catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
}
finally {
    $Password = $null
}

# SEGURIDAD: `adb shell input text` transmite la contrasena como argumento de
# linea de comandos, visible en `ps` dentro del dispositivo durante un instante.
# No existe forma de escribir texto en Android via ADB sin esa exposicion. No
# reutilices aqui una contrasena que compartas con otros servicios.