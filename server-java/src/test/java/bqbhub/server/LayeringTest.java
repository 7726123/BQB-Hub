package bqbhub.server;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.RestController;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * 分层边界（ADR-0005 的执行者）：不写这几条，多人协作时边界一定会漂回去。
 *
 * 允许的例外只有一处——`worldbook/WbSearch`：它是检索的查询引擎（多路 LIKE + RRF 打分），
 * 天然就是数据访问层，只是名字不叫 Repository。
 */
@AnalyzeClasses(packages = "bqbhub.server", importOptions = ImportOption.DoNotIncludeTests.class)
class LayeringTest {

    private static final String FEATURES =
            "bqbhub.server.(auth|card|feedback|plugin|preset|proxy|review|system|worldbook)..";

    @ArchTest
    static final ArchRule 控制器不许碰JdbcTemplate =
            noClasses().that().areAnnotatedWith(RestController.class)
                    .should().dependOnClassesThat().areAssignableTo(JdbcTemplate.class)
                    .because("Controller 只做解析 / 守卫 / 转发；SQL 归 Repository（ADR-0005）");

    @ArchTest
    static final ArchRule 功能包只有Repository能用JdbcTemplate =
            noClasses().that().resideInAPackage(FEATURES)
                    .and().haveSimpleNameNotEndingWith("Repository")
                    .and().haveSimpleNameNotEndingWith("WbSearch")   // 检索的查询引擎，见类注释
                    .should().dependOnClassesThat().areAssignableTo(JdbcTemplate.class)
                    .because("功能包的数据库访问收口到 *Repository（ADR-0005）");

    @ArchTest
    static final ArchRule 控制器不许直接依赖Repository =
            noClasses().that().areAnnotatedWith(RestController.class)
                    .should().dependOnClassesThat().haveSimpleNameEndingWith("Repository")
                    .because("链路必须是 Controller → Service → Repository，跳层就绕过了业务规则（ADR-0005）");

    @ArchTest
    static final ArchRule support不反向依赖功能包 =
            noClasses().that().resideInAPackage("bqbhub.server.support..")
                    .should().dependOnClassesThat().resideInAPackage(FEATURES)
                    .because("support 是共享内核（守卫 / 可见性），不许知道任何领域包（ADR-0005）");
}
