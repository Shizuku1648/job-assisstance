from app.models import UserProfile


DEFAULT_PROFILE = UserProfile(
    expected_salary_min_k=20,
    candidate_cities=["上海"],
    description=(
        "具备近 2 年 AI 应用开发与项目交付经验，主要方向包括企业级 AI 应用平台、"
        "智能客服、智能 BI、招聘助手、RAG / GraphRAG 和 Agent 工作流。熟悉 Python、"
        "FastAPI、RESTful API、接口联调、异常处理、日志排查和后端工程化，能够将 AI "
        "能力封装为稳定可交付的服务。熟悉 LangGraph、LangChain、Dify 等智能体与工作流"
        "开发方式，理解结构化输出、Function Call、MCP 工具接入、多步骤任务处理、HIL、"
        "记忆机制和上下文管理。熟悉 RAG / GraphRAG 核心链路，包括数据清洗、文档解析、"
        "文本切分、Embedding、向量检索、全文检索、混合检索、RRF 排序融合、知识溯源、"
        "图谱增强检索和幻觉评估。熟悉 PostgreSQL、MySQL、Redis、Elasticsearch、"
        "Weaviate、Milvus、Neo4j 等存储和检索组件在知识库、向量检索、图谱查询和业务"
        "系统中的应用。有企业级 AI 应用平台 RAG 检索引擎、插件化工具调用模块、GraphRAG "
        "智能客服、Text-to-SQL / Text-to-Cypher 智能查询、智能 BI 报表助手和招聘助手等"
        "项目经验。重视工程落地、结果可复核、过程可观测、异常兜底和交付稳定性。"
    ),
)
