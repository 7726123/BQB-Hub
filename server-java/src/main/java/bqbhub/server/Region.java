package bqbhub.server;

/**
 * 地区拦截（对应 server/src/region.js 的 isBlockedIp）。
 * Node 版用 geoip-lite 离线库（依赖自带 mmdb）。Java 版**暂未移植**——当前生产与测试都是
 * regionBlock=false，所以行为一致；真要开这个开关前必须先补 geoip（见 server-java/README.md 缺口清单）。
 */
public final class Region {

    private Region() {
    }

    public static boolean blocked(String ip) {
        return false;
    }
}
