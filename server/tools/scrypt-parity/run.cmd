@echo off
rem scrypt 跨语言对拍 · 一键运行（Windows cmd.exe，双击也可以）
rem 正向：Node 生成夹具 → Java 逐字节复算；反向：Java 现场生成 → Node 校验。
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo 缺少 node & exit /b 1)
where javac >nul 2>nul || (echo 缺少 JDK ^(javac^)，装 JDK 17+ 后重试 & exit /b 1)

rem 只在 modules-2 / .m2 里找**原始** jar：Gradle 的 jars-9 副本是插桩 jar，
rem 当 classpath 用会报 NoClassDefFoundError: org/gradle/internal/classpath/Instrumented
set "BC_JAR=%BCPROV_JAR%"
if "%BC_JAR%"=="" (
  for /f "delims=" %%i in ('dir /b /s "%USERPROFILE%\.gradle\caches\modules-2\bcprov*.jar" 2^>nul') do set "BC_JAR=%%i"
)
if "%BC_JAR%"=="" (
  for /f "delims=" %%i in ('dir /b /s "%USERPROFILE%\.m2\repository\bcprov*.jar" 2^>nul') do set "BC_JAR=%%i"
)
if "%BC_JAR%"=="" (
  echo 没找到 Bouncy Castle ^(bcprov^) jar。
  echo   办法 1：set BCPROV_JAR=^<bcprov*.jar 的路径^> 再跑本脚本
  echo   办法 2：curl -L -o bcprov.jar https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/1.78.1/bcprov-jdk18on-1.78.1.jar
  echo           然后 set BCPROV_JAR=bcprov.jar
  exit /b 2
)
echo BC jar: %BC_JAR%

node gen-fixtures.mjs || exit /b 1

set "OUT=%TEMP%\scrypt-parity-out"
if exist "%OUT%" rd /s /q "%OUT%"
mkdir "%OUT%"
rem -encoding UTF-8 必须带：Windows 上 javac 默认用平台编码（GBK），源码里的中文注释会编译失败
javac -encoding UTF-8 -cp "%BC_JAR%" -d "%OUT%" ScryptParity.java || exit /b 1
java -cp "%OUT%;%BC_JAR%" ScryptParity . || exit /b 1

node gen-fixtures.mjs --verify-java java-generated.tsv || exit /b 1
echo.
echo 全部通过：两条口令路径在 Node 与 Java 之间逐字节一致（正向 + 反向）。
